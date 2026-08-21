'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROOF_OPERATION = 'prove_approved_teacher_lesson';
const MAX_REQUEST_AGE_MS = 60000;
const LESSON_TITLE = String.fromCharCode(1044,1086,1082,1072,1079,1091,1077,1084,32,1079,1072,1090,1074,1086,1088,1077,1085,32,1094,1080,1082,1098,1083);

function sha256(value) {
 return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
 return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function validateProofRequest(request, nowMs, processedIds) {
 if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_REQUEST');
 if (Object.keys(request).sort().join(',') !== 'operation,request_id,timestamp') throw new Error('INVALID_REQUEST_SHAPE');
 if (request.operation !== PROOF_OPERATION) throw new Error('UNKNOWN_OPERATION');
 if (typeof request.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.request_id)) throw new Error('INVALID_REQUEST_ID');
 const timestampMs = Date.parse(request.timestamp);
 if (!Number.isFinite(timestampMs)) throw new Error('INVALID_TIMESTAMP');
 const ageMs = nowMs - timestampMs;
 if (ageMs < -5000 || ageMs > MAX_REQUEST_AGE_MS) throw new Error('EXPIRED_REQUEST');
 if (processedIds.has(request.request_id)) throw new Error('REPLAY_REQUEST');
}

async function proveApprovedTeacherLesson({ teacher, buildTeacherContext, request, processedIds = new Set(), nowMs = Date.now() }) {
 validateProofRequest(request, nowMs, processedIds);
 processedIds.add(request.request_id);
 if (!teacher || !teacher.bridge || typeof teacher.bridge.fetchApprovedTeacherLessons !== 'function') throw new Error('PRODUCTION_TEACHER_UNAVAILABLE');
 if (typeof buildTeacherContext !== 'function') throw new Error('BUILD_TEACHER_CONTEXT_UNAVAILABLE');
 const lessons = await teacher.bridge.fetchApprovedTeacherLessons();
 const lesson = (lessons || []).find((item) => item && item.status === 'approved' && (String(item.trigger_text || '').includes(LESSON_TITLE) || String(item.lesson_text || '').includes(LESSON_TITLE)));
 if (!lesson) throw new Error('APPROVED_LESSON_NOT_FOUND');
 const teacherContext = buildTeacherContext({ proof_request_id: request.request_id }, lessons);
 const contextLessons = teacherContext && Array.isArray(teacherContext.approved_twin_teacher_lessons) ? teacherContext.approved_twin_teacher_lessons : [];
 const exactLessonInContext = contextLessons.some((item) => item && item.lesson_text === lesson.lesson_text);
 return {
 live_read: true,
 table: 'sf_twin_teacher_lessons',
 record_id: String(lesson.id || ''),
 status: String(lesson.status || ''),
 created_at: String(lesson.created_at || ''),
 lesson_checksum_sha256: sha256(lesson.lesson_text),
 teacher_context_checksum_sha256: sha256(stableJson(teacherContext)),
 exact_lesson_in_context: exactLessonInContext
 };
}

function writeJsonAtomic(filePath, value) {
 const temporaryPath = filePath + '.tmp';
 fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
 fs.renameSync(temporaryPath, filePath);
}

function startTeacherProofChannel({ rootDir, teacher, buildTeacherContext, pollMs = 250 }) {
 const proofDir = path.join(rootDir, '.david-runtime', 'teacher-proof');
 fs.mkdirSync(proofDir, { recursive: true });
 const processedIds = new Set();
 let busy = false;
 const timer = setInterval(async () => {
 if (busy) return;
 const names = fs.readdirSync(proofDir).filter((name) => /^request-[0-9a-f-]+\.json$/i.test(name)).sort();
 if (names.length === 0) return;
 busy = true;
 const requestPath = path.join(proofDir, names[0]);
 try {
 const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
 if (names[0] !== 'request-' + request.request_id + '.json') throw new Error('REQUEST_FILE_ID_MISMATCH');
 const result = await proveApprovedTeacherLesson({ teacher, buildTeacherContext, request, processedIds });
 writeJsonAtomic(path.join(proofDir, 'result-' + request.request_id + '.json'), result);
 } catch (error) {
 void error;
 } finally {
 try { fs.unlinkSync(requestPath); } catch (error) { void error; }
 busy = false;
 }
 }, pollMs);
 if (typeof timer.unref === 'function') timer.unref();
 return () => clearInterval(timer);
}

module.exports = {
 PROOF_OPERATION,
 MAX_REQUEST_AGE_MS,
 validateProofRequest,
 proveApprovedTeacherLesson,
 startTeacherProofChannel,
 stableJson,
 sha256
};
