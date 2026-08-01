"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class LocalStore {
  constructor(baseDirectory) {
    this.directory = path.join(baseDirectory, "david-data");
    this.file = path.join(this.directory, "state.json");
    fs.mkdirSync(this.directory, { recursive: true });
    this.state = this.#read();
  }

  #read() {
    try {
      if (!fs.existsSync(this.file)) {
        return {
          deviceId: crypto.randomUUID(),
          auth: {},
          skills: [],
          runs: []
        };
      }

      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));

      return {
        deviceId: parsed.deviceId || crypto.randomUUID(),
        auth: parsed.auth || {},
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : []
      };
    } catch (error) {
      const backup = `${this.file}.broken-${Date.now()}`;
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
      return {
        deviceId: crypto.randomUUID(),
        auth: {},
        skills: [],
        runs: []
      };
    }
  }

  save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(temporary, this.file);
  }

  getDeviceId() {
    return this.state.deviceId;
  }

  getSkills() {
    return [...this.state.skills];
  }

  upsertSkill(skill) {
    const index = this.state.skills.findIndex(
      (item) => item.skill_key === skill.skill_key
    );

    if (index >= 0) {
      const currentVersion = Number(this.state.skills[index].version || 0);
      const incomingVersion = Number(skill.version || 0);
      if (incomingVersion >= currentVersion) {
        this.state.skills[index] = skill;
      }
    } else {
      this.state.skills.push(skill);
    }

    this.save();
  }

  addRun(run) {
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 250);
    this.save();
  }

  async authGet(key) {
    return this.state.auth[key] ?? null;
  }

  async authSet(key, value) {
    this.state.auth[key] = value;
    this.save();
  }

  async authRemove(key) {
    delete this.state.auth[key];
    this.save();
  }
}

module.exports = { LocalStore };
