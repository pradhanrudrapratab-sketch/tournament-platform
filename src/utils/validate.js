const { HttpError } = require('./errors');
const bad = (name) => new HttpError(400, 'INVALID_INPUT', `${name} is invalid`);

module.exports = {
  int(x, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(name);
    return n;
  },
  str(x, name, { min = 1, max = 200 } = {}) {
    if (typeof x !== 'string') throw bad(name);
    const s = x.trim();
    if (s.length < min || s.length > max) throw bad(name);
    return s;
  },
  optStr(x, name, max = 4000) {
    if (x == null || x === '') return null;
    return module.exports.str(x, name, { min: 0, max });
  },
  date(x, name) {
    const d = new Date(x);
    if (!x || Number.isNaN(d.getTime())) throw bad(name);
    return d;
  },
  optDate(x, name) {
    return x == null || x === '' ? null : module.exports.date(x, name);
  },
  oneOf(x, name, list) {
    if (!list.includes(x)) throw bad(name);
    return x;
  },
  bool(x) { return x === true || x === 'true'; },
};
