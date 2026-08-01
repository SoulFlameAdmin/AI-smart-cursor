"use strict";

const fs = require("fs");
const path = require("path");

class MemoryStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = {
      version: "0.1.0-start",
      upgradeRequests: [],
      upgradeResults: []
    };

    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;

    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));

    this.state = {
      ...this.state,
      ...parsed,
      upgradeRequests: Array.isArray(parsed.upgradeRequests)
        ? parsed.upgradeRequests
        : [],
      upgradeResults: Array.isArray(parsed.upgradeResults)
        ? parsed.upgradeResults
        : []
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.state, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(temporaryPath, this.filePath);
  }

  recordUpgradeRequest(request) {
    const entry = {
      id: `upgrade-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...request
    };

    this.state.upgradeRequests.push(entry);
    this.save();
    return entry;
  }

  recordUpgradeResult(result) {
    const entry = {
      createdAt: new Date().toISOString(),
      ...result
    };

    this.state.upgradeResults.push(entry);
    this.save();
    return entry;
  }
}

module.exports = {
  MemoryStore
};
