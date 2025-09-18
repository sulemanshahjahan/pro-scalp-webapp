"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushToAll = pushToAll;
exports.notifyAll = notifyAll;
var mailer_1 = require("./mailer");
var emailTemplates_1 = require("./emailTemplates");
// Your existing push broadcast (keep as-is)
function pushToAll(signal) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/];
        });
    });
}
var COOLDOWN_MIN = Number(process.env.EMAIL_COOLDOWN_MIN || 15);
var recipients = (process.env.ALERT_EMAILS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
// Provide a single entry point you can call from scanner
function notifyAll(db, signal) {
    return __awaiter(this, void 0, void 0, function () {
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: 
                // Always do push first (unchanged)
                return [4 /*yield*/, safeRun(function () { return pushToAll(signal); })];
                case 1:
                    // Always do push first (unchanged)
                    _a.sent();
                    // Only email for these categories
                    if (!isEligibleForEmail(signal))
                        return [2 /*return*/];
                    return [4 /*yield*/, safeRun(function () { return __awaiter(_this, void 0, void 0, function () {
                            var _a, ensureEmailGuardTables, canSendEmail, markEmailSent, key, gate;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        if (!(0, mailer_1.isEmailEnabled)() || recipients.length === 0)
                                            return [2 /*return*/];
                                        return [4 /*yield*/, Promise.resolve().then(function () { return require('./db/emailGuards'); })];
                                    case 1:
                                        _a = _b.sent(), ensureEmailGuardTables = _a.ensureEmailGuardTables, canSendEmail = _a.canSendEmail, markEmailSent = _a.markEmailSent;
                                        ensureEmailGuardTables(db);
                                        key = "".concat(signal.symbol, "|").concat(signal.category);
                                        gate = canSendEmail(db, key, COOLDOWN_MIN);
                                        if (!gate.allowed)
                                            return [2 /*return*/];
                                        return [4 /*yield*/, (0, mailer_1.sendMail)({
                                                to: recipients,
                                                subject: (0, emailTemplates_1.subjectFor)(signal),
                                                html: (0, emailTemplates_1.htmlFor)(signal),
                                                text: (0, emailTemplates_1.textFor)(signal),
                                            })];
                                    case 2:
                                        _b.sent();
                                        markEmailSent(db, key, gate.now);
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function isEligibleForEmail(signal) {
    return (signal === null || signal === void 0 ? void 0 : signal.category) === 'BEST_ENTRY' || (signal === null || signal === void 0 ? void 0 : signal.category) === 'READY_TO_BUY';
}
function safeRun(fn) {
    return __awaiter(this, void 0, void 0, function () {
        var e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fn()];
                case 1: return [2 /*return*/, _a.sent()];
                case 2:
                    e_1 = _a.sent();
                    console.error('[notifyAll] error:', e_1);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
