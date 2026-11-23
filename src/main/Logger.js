"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const fsPromises = require("node:fs/promises");
const { BoundedLogWriter } = require("./BoundedLogWriter");
const node_path_1 = __importDefault(require("node:path"));
const SECRET_PATTERNS = [
    /\/\/[^@/\s]+@/g, // user:pass@ in URLs
    /"password"\s*:\s*"[^"]*"/gi,
    /"apiKey"\s*:\s*"[^"]*"/gi
];
function redact(message) {
    let out = message;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, (m) => (m.includes('@') ? '//***@' : m.split(':')[0] + '":"***"'));
    }
    return out;
}
/**
 * Structured, append-only logger writing to logs/<channel>.log under
 * userData. Never logs passwords or API keys (see redact()). Falls back to
 * console-only logging if the log directory can't be created (e.g. in unit
 * tests where `app` isn't ready), so tests never depend on filesystem state.
 */
class Logger {
    closed = false;
    streams = {};
    logsDir = null;
    clearingLogs = null;
    fileWritesPaused = false;
    ensureDir() {
        if (this.logsDir)
            return this.logsDir;
        try {
            const dir = node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
            if (!(0, node_fs_1.existsSync)(dir))
                (0, node_fs_1.mkdirSync)(dir, { recursive: true });
            this.logsDir = dir;
            return dir;
        }
        catch {
            return null;
        }
    }
    streamFor(channel) {
        if (this.streams[channel])
            return this.streams[channel];
        const dir = this.ensureDir();
        if (!dir)
            return null;
        const stream = new BoundedLogWriter(node_path_1.default.join(dir, `${channel}.log`));
        this.streams[channel] = stream;
        return stream;
    }
    write(channel, level, message) {
        if (this.closed) return;
        const safe = redact(message);
        const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${channel}] ${safe}`;
        // Keep console output while a 10-cycle log reset closes old writers.
        // New file writes resume when the reset is complete.
        const stream = this.fileWritesPaused ? null : this.streamFor(channel);
        if (stream)
            stream.write(line + '\n');
        // eslint-disable-next-line no-console
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    }
    info(channel, message) {
        this.write(channel, 'info', message);
    }
    warn(channel, message) {
        this.write(channel, 'warn', message);
    }
    error(channel, message) {
        this.write(channel, 'error', message);
    }
    async clearHistory() {
        if (this.closed) return;
        if (this.clearingLogs) return this.clearingLogs;
        this.fileWritesPaused = true;
        const oldStreams = this.streams;
        this.streams = {};
        this.clearingLogs = (async () => {
            // Flush and close queued writers before deleting on Windows.
            await Promise.all(Object.values(oldStreams).map((stream) => stream.close()));
            const dir = this.ensureDir();
            if (!dir) throw new Error('IMP log directory is unavailable.');
            const files = await fsPromises.readdir(dir, { withFileTypes: true });
            // Delete only IMP channel logs and rotation backups, not settings.
            await Promise.all(files.filter((file) => file.isFile() &&
                /^[a-z0-9_-]+\.log(?:\.\d+)?$/i.test(file.name))
                .map((file) => fsPromises.rm(node_path_1.default.join(dir, file.name), { force: true })));
        })();
        try {
            await this.clearingLogs;
        } finally {
            this.clearingLogs = null;
            this.fileWritesPaused = false;
        }
    }
    async close() {
        this.closed = true;
        if (this.clearingLogs) await this.clearingLogs.catch(() => {});
        await Promise.allSettled(Object.values(this.streams).map((stream) => stream.close()));
        this.streams = {};
    }
    logsFolderPath() {
        return this.ensureDir() ?? node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    }
}
exports.logger = new Logger();
//# sourceMappingURL=Logger.js.map