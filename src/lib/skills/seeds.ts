/**
 * Built-in skills. Each is real, pure, synchronous JavaScript executed in the sandbox.
 * Their status starts as EXPERIMENTAL and is only raised by the validator after the tests below
 * genuinely pass in the sandbox - nothing here is pre-marked VERIFIED.
 * Self-contained (no imports) so it can be tested directly.
 */

export interface SeedSkill {
  slug: string;
  name: string;
  description: string;
  category: string;
  limitations: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  triggers: string[];
  tests: Array<{ name: string; input: unknown; expect?: unknown; expectError?: boolean | string }>;
  code: string;
}

export const BUILTIN_CATEGORIES: Array<[string, string]> = [
  ["Programming", "Code, text and data transformation helpers"],
  ["Cybersecurity", "Defensive security utilities"],
  ["Web development", "Web and API related skills"],
  ["Android development", "Android tooling and device workflows"],
  ["Windows automation", "Windows desktop and administration workflows"],
  ["Artificial intelligence", "AI agents, prompting and model tooling"],
  ["Machine learning", "Statistical learning and modelling"],
  ["Data science", "Data parsing, profiling and analysis"],
  ["Mathematics", "Calculation, conversion and numerics"],
  ["Scientific research", "Experiment and measurement helpers"],
  ["Business intelligence", "Decision support and analytics"],
  ["Financial analysis", "Finance calculators and modelling"],
  ["Robotics", "Robotics and control calculations"],
  ["System administration", "Operating system and infrastructure tasks"],
  ["Multimedia processing", "Audio, image and video processing"],
  ["Creative design", "Design and creative generation"],
  ["Communication", "Language and text communication"],
  ["Education", "Learning and teaching support"],
  ["General problem-solving", "General purpose utilities"],
];

const mathEvaluate = String.raw`
function run(input) {
  if (!input || typeof input.expression !== 'string') throw new Error('expression must be a string');
  var src = input.expression.replace(/\s+/g, '');
  if (src.length === 0) throw new Error('empty expression');
  if (src.length > 200) throw new Error('expression too long');
  var pos = 0;
  var FUNCS = { sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max };
  var CONSTS = { pi: Math.PI, e: Math.E };
  function peek() { return src.charAt(pos); }
  function parseExpr() {
    var v = parseTerm();
    while (peek() === '+' || peek() === '-') { var op = src.charAt(pos++); var r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function parseTerm() {
    var v = parseUnary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      var op = src.charAt(pos++); var r = parseUnary();
      if (op === '*') v = v * r;
      else { if (r === 0) throw new Error('division by zero'); v = op === '/' ? v / r : v % r; }
    }
    return v;
  }
  function parseUnary() {
    if (peek() === '-') { pos++; return -parseUnary(); }
    if (peek() === '+') { pos++; return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    var base = parsePrimary();
    if (peek() === '^') { pos++; return Math.pow(base, parseUnary()); }
    return base;
  }
  function parsePrimary() {
    var c = peek();
    if (c === '(') {
      pos++; var v = parseExpr();
      if (peek() !== ')') throw new Error('missing closing parenthesis');
      pos++; return v;
    }
    if (c !== '' && /[0-9.]/.test(c)) {
      var start = pos;
      while (pos < src.length && /[0-9.]/.test(peek())) pos++;
      var s = src.slice(start, pos);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error('invalid number: ' + s);
      return parseFloat(s);
    }
    if (c !== '' && /[a-z]/i.test(c)) {
      var st = pos;
      while (pos < src.length && /[a-z]/i.test(peek())) pos++;
      var name = src.slice(st, pos).toLowerCase();
      if (peek() === '(') {
        if (!Object.prototype.hasOwnProperty.call(FUNCS, name)) throw new Error('unknown function: ' + name);
        pos++; var args = [];
        if (peek() !== ')') { args.push(parseExpr()); while (peek() === ',') { pos++; args.push(parseExpr()); } }
        if (peek() !== ')') throw new Error('missing closing parenthesis');
        pos++;
        return FUNCS[name].apply(null, args);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return CONSTS[name];
      throw new Error('unknown identifier: ' + name);
    }
    throw new Error('unexpected character: ' + (c || 'end of input'));
  }
  var result = parseExpr();
  if (pos < src.length) throw new Error('unexpected character: ' + src.charAt(pos));
  if (typeof result !== 'number' || !isFinite(result)) throw new Error('result is not a finite number');
  return { expression: input.expression, result: result };
}
`;

const textStats = String.raw`
function run(input) {
  if (!input || typeof input.text !== 'string') throw new Error('text must be a string');
  var text = input.text;
  if (text.length > 100000) throw new Error('text too long');
  var words = text.toLowerCase().match(/[\p{L}\p{M}\p{N}']+/gu) || [];
  var sentences = (text.match(/[^.!?\u0964]+[.!?\u0964]+|[^.!?\u0964]+$/g) || []).filter(function (s) { return s.trim().length > 0; });
  var freq = Object.create(null);
  words.forEach(function (w) { if (w.length > 2) freq[w] = (freq[w] || 0) + 1; });
  var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a] || (a < b ? -1 : 1); }).slice(0, 5).map(function (w) { return { word: w, count: freq[w] }; });
  var total = words.reduce(function (n, w) { return n + w.length; }, 0);
  return {
    characters: text.length, words: words.length, sentences: sentences.length,
    avgWordLength: words.length ? Math.round(total / words.length * 100) / 100 : 0,
    readingTimeSeconds: Math.round(words.length / 200 * 60), topWords: top
  };
}
`;

const slugify = String.raw`
function run(input) {
  if (!input || typeof input.text !== 'string') throw new Error('text must be a string');
  var s = input.text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  var max = typeof input.maxLength === 'number' ? Math.max(1, Math.floor(input.maxLength)) : 80;
  s = s.slice(0, max).replace(/-+$/, '');
  return { slug: s };
}
`;

const unitConvert = String.raw`
function run(input) {
  if (!input || typeof input.value !== 'number' || !isFinite(input.value)) throw new Error('value must be a finite number');
  if (typeof input.from !== 'string' || typeof input.to !== 'string') throw new Error('from and to must be strings');
  function norm(u) { return u.toLowerCase().replace(/[\u00b0\s]/g, '').replace('/', ''); }
  var UNITS = {
    m: ['length', 1], meter: ['length', 1], km: ['length', 1000], cm: ['length', 0.01], mm: ['length', 0.001],
    mi: ['length', 1609.344], mile: ['length', 1609.344], yd: ['length', 0.9144], ft: ['length', 0.3048], foot: ['length', 0.3048], feet: ['length', 0.3048], inch: ['length', 0.0254], in: ['length', 0.0254],
    kg: ['mass', 1], g: ['mass', 0.001], mg: ['mass', 0.000001], lb: ['mass', 0.45359237], oz: ['mass', 0.028349523125], tonne: ['mass', 1000],
    l: ['volume', 1], liter: ['volume', 1], ml: ['volume', 0.001], gal: ['volume', 3.785411784], qt: ['volume', 0.946352946], cup: ['volume', 0.2365882365],
    s: ['time', 1], sec: ['time', 1], min: ['time', 60], h: ['time', 3600], hr: ['time', 3600], hour: ['time', 3600], day: ['time', 86400], week: ['time', 604800],
    ms: ['speed', 1], kmh: ['speed', 1 / 3.6], kph: ['speed', 1 / 3.6], mph: ['speed', 0.44704], kn: ['speed', 0.514444]
  };
  var TEMPS = { c: 1, celsius: 1, f: 1, fahrenheit: 1, k: 1, kelvin: 1 };
  function alias(u) {
    if (Object.prototype.hasOwnProperty.call(UNITS, u) || Object.prototype.hasOwnProperty.call(TEMPS, u)) return u;
    var singular = u.replace(/s$/, '');
    if (Object.prototype.hasOwnProperty.call(UNITS, singular)) return singular;
    return u;
  }
  var from = alias(norm(input.from)), to = alias(norm(input.to));
  var out;
  if (Object.prototype.hasOwnProperty.call(TEMPS, from) && Object.prototype.hasOwnProperty.call(TEMPS, to)) {
    var f0 = from.charAt(0), t0 = to.charAt(0), c;
    c = f0 === 'c' ? input.value : f0 === 'f' ? (input.value - 32) * 5 / 9 : input.value - 273.15;
    out = t0 === 'c' ? c : t0 === 'f' ? c * 9 / 5 + 32 : c + 273.15;
  } else {
    if (!Object.prototype.hasOwnProperty.call(UNITS, from)) throw new Error('unknown unit: ' + input.from);
    if (!Object.prototype.hasOwnProperty.call(UNITS, to)) throw new Error('unknown unit: ' + input.to);
    if (UNITS[from][0] !== UNITS[to][0]) throw new Error('incompatible units: ' + UNITS[from][0] + ' vs ' + UNITS[to][0]);
    out = input.value * UNITS[from][1] / UNITS[to][1];
  }
  return { value: input.value, from: input.from, to: input.to, result: Number(out.toPrecision(10)) };
}
`;

const csvSummary = String.raw`
function run(input) {
  if (!input || typeof input.csv !== 'string') throw new Error('csv must be a string');
  if (input.csv.length > 200000) throw new Error('csv too large');
  var rows = [], row = [], field = '', inQ = false, text = input.csv.replace(/\r\n?/g, '\n');
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inQ) {
      if (ch === '"') { if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  rows = rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
  if (rows.length < 2) throw new Error('csv needs a header row and at least one data row');
  var header = rows[0].map(function (h) { return h.trim(); });
  var data = rows.slice(1);
  var columns = header.map(function (name, c) {
    var vals = data.map(function (r) { return (r[c] === undefined ? '' : r[c]).trim(); }).filter(function (v) { return v !== ''; });
    var nums = vals.map(function (v) { return Number(v); }).filter(function (n) { return isFinite(n); });
    if (vals.length > 0 && nums.length === vals.length) {
      var sorted = nums.slice().sort(function (a, b) { return a - b; });
      var sum = nums.reduce(function (a, b) { return a + b; }, 0);
      var mid = Math.floor(sorted.length / 2);
      var median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return { name: name, type: 'number', count: nums.length, missing: data.length - vals.length, min: sorted[0], max: sorted[sorted.length - 1], mean: Math.round(sum / nums.length * 1e6) / 1e6, median: median };
    }
    var counts = Object.create(null);
    vals.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    return { name: name, type: 'text', count: vals.length, missing: data.length - vals.length, unique: keys.length, top: keys.slice(0, 3).map(function (k) { return { value: k, count: counts[k] }; }) };
  });
  return { rows: data.length, columnCount: header.length, columns: columns };
}
`;

const passwordStrength = String.raw`
function run(input) {
  if (!input || typeof input.password !== 'string') throw new Error('password must be a string');
  var p = input.password;
  if (p.length === 0) throw new Error('password must not be empty');
  if (p.length > 256) throw new Error('password too long');
  var pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  var entropy = Math.round(p.length * Math.log(pool) / Math.LN2 * 10) / 10;
  var issues = [];
  var capped = null;
  if (p.length < 12) issues.push('shorter than 12 characters');
  if (/^(.)\1+$/.test(p)) { issues.push('single repeated character'); capped = 'very weak'; }
  else if (/(.)\1{2,}/.test(p)) issues.push('3 or more identical characters in a row');
  if (/(password|qwerty|letmein|admin|welcome|123456|iloveyou)/i.test(p)) { issues.push('contains a very common password pattern'); capped = capped || 'weak'; }
  var rating = entropy < 28 ? 'very weak' : entropy < 36 ? 'weak' : entropy < 60 ? 'fair' : entropy < 80 ? 'strong' : 'very strong';
  if (capped === 'very weak') rating = 'very weak';
  else if (capped === 'weak' && (rating === 'fair' || rating === 'strong' || rating === 'very strong')) rating = 'weak';
  return { rating: rating, entropyBits: entropy, length: p.length, issues: issues };
}
`;

const dateDiff = String.raw`
function run(input) {
  if (!input) throw new Error('input required');
  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) throw new Error('dates must be YYYY-MM-DD');
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var chk = new Date(t);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) throw new Error('invalid calendar date: ' + s);
    return t;
  }
  var names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var a = parse(input.a), b = parse(input.b);
  var days = Math.round((b - a) / 86400000);
  var abs = Math.abs(days);
  return { days: days, absoluteDays: abs, weeks: Math.floor(abs / 7), remainderDays: abs % 7, weekdayA: names[new Date(a).getUTCDay()], weekdayB: names[new Date(b).getUTCDay()] };
}
`;

const decisionMatrix = String.raw`
function run(input) {
  if (!input || !Array.isArray(input.options) || input.options.length < 2) throw new Error('need at least two options');
  if (!Array.isArray(input.criteria) || input.criteria.length < 1) throw new Error('need at least one criterion');
  if (!input.scores || typeof input.scores !== 'object') throw new Error('scores required');
  var totalW = 0;
  input.criteria.forEach(function (c) {
    if (!c || typeof c.name !== 'string' || typeof c.weight !== 'number' || c.weight < 0) throw new Error('each criterion needs a name and non-negative weight');
    totalW += c.weight;
  });
  if (totalW <= 0) throw new Error('total weight must be positive');
  var ranking = input.options.map(function (opt) {
    var row = input.scores[opt];
    if (!row || typeof row !== 'object') throw new Error('missing scores for option: ' + opt);
    var sum = 0;
    input.criteria.forEach(function (c) {
      var s = row[c.name];
      if (typeof s !== 'number' || s < 0 || s > 10) throw new Error('score for ' + opt + '/' + c.name + ' must be a number 0-10');
      sum += s * c.weight;
    });
    return { option: opt, score: Math.round(sum / totalW * 100) / 100 };
  });
  ranking.sort(function (a, b) { return b.score - a.score; });
  var margin = Math.round((ranking[0].score - ranking[1].score) * 100) / 100;
  return { winner: ranking[0].option, margin: margin, ranking: ranking, confidence: margin >= 1.5 ? 'clear' : margin >= 0.5 ? 'moderate' : 'close call' };
}
`;

const compoundInterest = String.raw`
function run(input) {
  if (!input || typeof input.principal !== 'number' || input.principal < 0) throw new Error('principal must be a non-negative number');
  if (typeof input.annualRatePercent !== 'number' || input.annualRatePercent < 0 || input.annualRatePercent > 1000) throw new Error('annualRatePercent must be between 0 and 1000');
  if (typeof input.years !== 'number' || input.years <= 0 || input.years > 200) throw new Error('years must be between 0 and 200');
  var n = input.compoundsPerYear === undefined ? 12 : input.compoundsPerYear;
  if (typeof n !== 'number' || n < 1 || n > 365 || Math.floor(n) !== n) throw new Error('compoundsPerYear must be an integer 1-365');
  var monthly = input.monthlyContribution === undefined ? 0 : input.monthlyContribution;
  if (typeof monthly !== 'number' || monthly < 0) throw new Error('monthlyContribution must be non-negative');
  var N = Math.round(n * input.years);
  var i = input.annualRatePercent / 100 / n;
  var c = monthly * 12 / n;
  var growth = Math.pow(1 + i, N);
  var fv = input.principal * growth + (i === 0 ? c * N : c * (growth - 1) / i);
  var contributed = input.principal + c * N;
  return { finalBalance: Math.round(fv * 100) / 100, totalContributed: Math.round(contributed * 100) / 100, interestEarned: Math.round((fv - contributed) * 100) / 100 };
}
`;

const linearRegression = String.raw`
function run(input) {
  if (!input || !Array.isArray(input.x) || !Array.isArray(input.y)) throw new Error('x and y must be arrays');
  if (input.x.length !== input.y.length) throw new Error('x and y must have the same length');
  var n = input.x.length;
  if (n < 2) throw new Error('need at least 2 points');
  if (n > 100000) throw new Error('too many points');
  for (var k = 0; k < n; k++) { if (typeof input.x[k] !== 'number' || typeof input.y[k] !== 'number' || !isFinite(input.x[k]) || !isFinite(input.y[k])) throw new Error('all values must be finite numbers'); }
  var mx = input.x.reduce(function (a, b) { return a + b; }, 0) / n;
  var my = input.y.reduce(function (a, b) { return a + b; }, 0) / n;
  var sxy = 0, sxx = 0, ssTot = 0;
  for (var i = 0; i < n; i++) { sxy += (input.x[i] - mx) * (input.y[i] - my); sxx += (input.x[i] - mx) * (input.x[i] - mx); ssTot += (input.y[i] - my) * (input.y[i] - my); }
  if (sxx === 0) throw new Error('x values must not all be identical');
  var slope = sxy / sxx, intercept = my - slope * mx, ssRes = 0;
  for (var j = 0; j < n; j++) { var e = input.y[j] - (slope * input.x[j] + intercept); ssRes += e * e; }
  function r6(v) { return Math.round(v * 1e6) / 1e6; }
  var out = { n: n, slope: r6(slope), intercept: r6(intercept), r2: r6(ssTot === 0 ? 1 : 1 - ssRes / ssTot) };
  if (Array.isArray(input.predict)) {
    out.predictions = input.predict.map(function (p) { if (typeof p !== 'number' || !isFinite(p)) throw new Error('predict values must be finite numbers'); return r6(slope * p + intercept); });
  }
  return out;
}
`;

const base64 = String.raw`
function run(input) {
  if (!input || typeof input.text !== 'string') throw new Error('text must be a string');
  if (input.mode !== 'encode' && input.mode !== 'decode') throw new Error('mode must be encode or decode');
  if (input.text.length > 100000) throw new Error('text too long');
  var CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function enc(str) {
    var bin = unescape(encodeURIComponent(str)), out = '';
    for (var i = 0; i < bin.length; i += 3) {
      var a = bin.charCodeAt(i), b = bin.charCodeAt(i + 1), c = bin.charCodeAt(i + 2);
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += CH.charAt((n >> 18) & 63) + CH.charAt((n >> 12) & 63) + (i + 1 < bin.length ? CH.charAt((n >> 6) & 63) : '=') + (i + 2 < bin.length ? CH.charAt(n & 63) : '=');
    }
    return out;
  }
  function dec(b64) {
    var s = b64.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('invalid base64');
    var bin = '';
    for (var i = 0; i < s.length; i += 4) {
      var n = 0, pad = 0;
      for (var j = 0; j < 4; j++) { var ch = s.charAt(i + j); if (ch === '=') { pad++; n = n << 6; } else n = (n << 6) | CH.indexOf(ch); }
      bin += String.fromCharCode((n >> 16) & 255);
      if (pad < 2) bin += String.fromCharCode((n >> 8) & 255);
      if (pad < 1) bin += String.fromCharCode(n & 255);
    }
    try { return decodeURIComponent(escape(bin)); } catch (e) { throw new Error('decoded bytes are not valid UTF-8'); }
  }
  return { mode: input.mode, output: input.mode === 'encode' ? enc(input.text) : dec(input.text) };
}
`;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

export const SEED_SKILLS: SeedSkill[] = [
  {
    slug: "math.evaluate", name: "Math Expression Evaluator", category: "Mathematics",
    description: "Safely evaluates arithmetic expressions with + - * / % ^, parentheses, constants (pi, e) and functions (sqrt, abs, sin, cos, tan, log, ln, exp, floor, ceil, round, min, max). Uses a hand-written parser; no eval.",
    limitations: "Real-number arithmetic only; no variables, no implicit multiplication, expressions limited to 200 characters.",
    inputSchema: obj({ expression: { type: "string", minLength: 1, maxLength: 200 } }, ["expression"]),
    outputSchema: obj({ expression: { type: "string" }, result: { type: "number" } }, ["result"]),
    triggers: [String.raw`^(?:calculate|compute|calc|evaluate|what is|what's|whats)\s+(?<expression>[\d(\-.][\d\s.+\-*/%^(),a-z]*?)\s*\??$`],
    tests: [
      { name: "operator precedence", input: { expression: "2+3*4" }, expect: { result: 14 } },
      { name: "parentheses and power", input: { expression: "(2+3)^2" }, expect: { result: 25 } },
      { name: "unary minus binds below power", input: { expression: "-2^2" }, expect: { result: -4 } },
      { name: "functions and constants", input: { expression: "sqrt(16)+abs(-3)" }, expect: { result: 7 } },
      { name: "right-associative power", input: { expression: "2^3^2" }, expect: { result: 512 } },
      { name: "division by zero rejected", input: { expression: "1/0" }, expectError: "division by zero" },
      { name: "dangling operator rejected", input: { expression: "2+" }, expectError: "unexpected" },
      { name: "unknown function rejected", input: { expression: "foo(1)" }, expectError: "unknown function" },
      { name: "code injection attempt rejected", input: { expression: "process.exit()" }, expectError: true },
    ],
    code: mathEvaluate,
  },
  {
    slug: "text.stats", name: "Text Statistics", category: "Communication",
    description: "Counts characters, words and sentences, estimates reading time and lists the most frequent words. Unicode aware (English, Tamil, Hindi).",
    limitations: "Word frequency ignores words of 1-2 characters; reading time assumes 200 words/minute.",
    inputSchema: obj({ text: { type: "string", maxLength: 100000 } }, ["text"]),
    outputSchema: obj({ words: { type: "integer" }, sentences: { type: "integer" }, characters: { type: "integer" } }, ["words", "sentences", "characters"]),
    triggers: [String.raw`^(?:text stats|analy[sz]e text|count words)[:\s]+(?<text>.+)$`],
    tests: [
      { name: "english counts", input: { text: "The cat sat. The cat ran!" }, expect: { words: 6, sentences: 2, characters: 25, avgWordLength: 3 } },
      { name: "top words ordering", input: { text: "The cat sat. The cat ran!" }, expect: { topWords: [{ word: "cat", count: 2 }, { word: "the", count: 2 }, { word: "ran", count: 1 }, { word: "sat", count: 1 }] } },
      { name: "tamil text", input: { text: "வணக்கம் உலகம்" }, expect: { words: 2 } },
      { name: "empty text", input: { text: "" }, expect: { words: 0, sentences: 0 } },
      { name: "non-string rejected", input: { text: 42 }, expectError: "text must be a string" },
    ],
    code: textStats,
  },
  {
    slug: "text.slugify", name: "Slug Generator", category: "Programming",
    description: "Turns arbitrary text into a URL-safe lowercase slug, removing accents and punctuation.",
    limitations: "Non-Latin scripts are dropped (ASCII slugs only).",
    inputSchema: obj({ text: { type: "string" }, maxLength: { type: "integer", minimum: 1, maximum: 200 } }, ["text"]),
    outputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    triggers: [String.raw`^(?:slugify|make a slug(?: for| from)?)[:\s]+(?<text>.+)$`],
    tests: [
      { name: "basic", input: { text: "Hello, World!" }, expect: { slug: "hello-world" } },
      { name: "accents", input: { text: "  Crème Brûlée  " }, expect: { slug: "creme-brulee" } },
      { name: "max length", input: { text: "hello world", maxLength: 5 }, expect: { slug: "hello" } },
      { name: "empty", input: { text: "" }, expect: { slug: "" } },
      { name: "null rejected", input: { text: null }, expectError: "text must be a string" },
    ],
    code: slugify,
  },
  {
    slug: "unit.convert", name: "Unit Converter", category: "Scientific research",
    description: "Converts between common length, mass, volume, time, speed and temperature units.",
    limitations: "Fixed built-in unit table; no compound units beyond the listed speed units.",
    inputSchema: obj({ value: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, ["value", "from", "to"]),
    outputSchema: obj({ result: { type: "number" } }, ["result"]),
    triggers: [String.raw`^convert\s+(?<value>-?\d+(?:\.\d+)?)\s*(?<from>[a-zA-Z\u00b0/]+)\s+(?:to|in|into)\s+(?<to>[a-zA-Z\u00b0/]+)$`],
    tests: [
      { name: "celsius to fahrenheit", input: { value: 100, from: "C", to: "F" }, expect: { result: 212 } },
      { name: "kelvin to celsius", input: { value: 0, from: "K", to: "C" }, expect: { result: -273.15 } },
      { name: "miles to km", input: { value: 1, from: "mi", to: "km" }, expect: { result: 1.609344 } },
      { name: "km to m", input: { value: 2.5, from: "km", to: "m" }, expect: { result: 2500 } },
      { name: "incompatible units", input: { value: 1, from: "kg", to: "m" }, expectError: "incompatible units" },
      { name: "unknown unit", input: { value: 1, from: "parsec", to: "m" }, expectError: "unknown unit" },
    ],
    code: unitConvert,
  },
  {
    slug: "data.csv_summary", name: "CSV Profiler", category: "Data science",
    description: "Parses CSV text (quoted fields supported) and profiles each column: numeric min/max/mean/median or text uniqueness and top values.",
    limitations: "Comma delimiter only; input limited to 200 KB; no type inference for dates.",
    inputSchema: obj({ csv: { type: "string", maxLength: 200000 } }, ["csv"]),
    outputSchema: obj({ rows: { type: "integer" }, columnCount: { type: "integer" }, columns: { type: "array" } }, ["rows", "columns"]),
    triggers: [],
    tests: [
      { name: "mixed columns", input: { csv: "name,age,city\nAnn,30,Paris\nBob,40,Paris\nCy,35,Rome" }, expect: { rows: 3, columnCount: 3, columns: [{ name: "name", type: "text", unique: 3 }, { name: "age", type: "number", min: 30, max: 40, mean: 35, median: 35 }, { name: "city", type: "text", unique: 2 }] } },
      { name: "quoted fields", input: { csv: 'x,y\n"a,b",1\n"c ""d""",2' }, expect: { rows: 2, columns: [{ name: "x", type: "text", unique: 2 }, { name: "y", type: "number", max: 2 }] } },
      { name: "missing values counted", input: { csv: "a,b\n1,\n2,x" }, expect: { columns: [{ name: "a", type: "number" }, { name: "b", type: "text", missing: 1 }] } },
      { name: "header only rejected", input: { csv: "a,b" }, expectError: "header row" },
    ],
    code: csvSummary,
  },
  {
    slug: "security.password_strength", name: "Password Strength Estimator", category: "Cybersecurity",
    description: "Estimates password entropy and flags common weaknesses. Runs fully offline in the sandbox; the password is never stored or logged by the skill.",
    limitations: "Heuristic entropy estimate based on character classes; does not check breach databases.",
    inputSchema: obj({ password: { type: "string", minLength: 1, maxLength: 256 } }, ["password"]),
    outputSchema: obj({ rating: { type: "string" }, entropyBits: { type: "number" } }, ["rating", "entropyBits"]),
    triggers: [],
    tests: [
      { name: "strong random password", input: { password: "Xk9#mQ2$vL7!pR4z" }, expect: { rating: "very strong", issues: [] } },
      { name: "common pattern capped", input: { password: "password123" }, expect: { rating: "weak" } },
      { name: "repeated character", input: { password: "aaaaaaaaaaaa" }, expect: { rating: "very weak" } },
      { name: "short password", input: { password: "abc" }, expect: { rating: "very weak" } },
      { name: "empty rejected", input: { password: "" }, expectError: "must not be empty" },
      { name: "non-string rejected", input: { password: 123 }, expectError: "password must be a string" },
    ],
    code: passwordStrength,
  },
  {
    slug: "datetime.diff", name: "Date Difference", category: "General problem-solving",
    description: "Calculates the number of days and weeks between two calendar dates (YYYY-MM-DD) and their weekdays, validating real calendar dates.",
    limitations: "Calendar dates only (UTC, no time-of-day or time zones).",
    inputSchema: obj({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
    outputSchema: obj({ days: { type: "integer" } }, ["days"]),
    triggers: [String.raw`^(?:days between|date diff(?:erence)?(?: between)?)\s+(?<a>\d{4}-\d{2}-\d{2})\s+(?:and|to)\s+(?<b>\d{4}-\d{2}-\d{2})$`],
    tests: [
      { name: "leap year span", input: { a: "2024-01-01", b: "2024-03-01" }, expect: { days: 60, weekdayA: "Monday", weekdayB: "Friday" } },
      { name: "reversed order", input: { a: "2024-03-01", b: "2024-01-01" }, expect: { days: -60, absoluteDays: 60, weeks: 8, remainderDays: 4 } },
      { name: "same day", input: { a: "2025-06-15", b: "2025-06-15" }, expect: { days: 0 } },
      { name: "impossible date rejected", input: { a: "2023-02-30", b: "2023-03-01" }, expectError: "invalid calendar date" },
      { name: "bad format rejected", input: { a: "abc", b: "2023-03-01" }, expectError: "YYYY-MM-DD" },
    ],
    code: dateDiff,
  },
  {
    slug: "strategy.decision_matrix", name: "Weighted Decision Matrix", category: "Business intelligence",
    description: "Ranks options against weighted criteria (scores 0-10) and reports the winner, margin and a confidence label.",
    limitations: "Scores and weights are supplied by the caller; the skill does not judge their quality.",
    inputSchema: obj({ options: { type: "array", minItems: 2, items: { type: "string" } }, criteria: { type: "array", minItems: 1 }, scores: { type: "object" } }, ["options", "criteria", "scores"]),
    outputSchema: obj({ winner: { type: "string" }, ranking: { type: "array" } }, ["winner", "ranking"]),
    triggers: [],
    tests: [
      { name: "close call", input: { options: ["A", "B"], criteria: [{ name: "cost", weight: 2 }, { name: "speed", weight: 1 }], scores: { A: { cost: 8, speed: 4 }, B: { cost: 5, speed: 9 } } }, expect: { winner: "A", confidence: "close call" } },
      { name: "clear winner", input: { options: ["X", "Y"], criteria: [{ name: "quality", weight: 1 }], scores: { X: { quality: 9 }, Y: { quality: 3 } } }, expect: { winner: "X", margin: 6, confidence: "clear" } },
      { name: "needs two options", input: { options: ["only"], criteria: [{ name: "q", weight: 1 }], scores: {} }, expectError: "at least two options" },
      { name: "score out of range", input: { options: ["A", "B"], criteria: [{ name: "q", weight: 1 }], scores: { A: { q: 11 }, B: { q: 1 } } }, expectError: "0-10" },
    ],
    code: decisionMatrix,
  },
  {
    slug: "finance.compound_interest", name: "Compound Interest Calculator", category: "Financial analysis",
    description: "Projects investment growth with periodic compounding and optional monthly contributions (end-of-period).",
    limitations: "Fixed nominal rate; ignores taxes, fees and inflation. Educational estimate, not financial advice.",
    inputSchema: obj({ principal: { type: "number", minimum: 0 }, annualRatePercent: { type: "number", minimum: 0 }, years: { type: "number", minimum: 0 }, compoundsPerYear: { type: "integer", minimum: 1 }, monthlyContribution: { type: "number", minimum: 0 } }, ["principal", "annualRatePercent", "years"]),
    outputSchema: obj({ finalBalance: { type: "number" }, totalContributed: { type: "number" }, interestEarned: { type: "number" } }, ["finalBalance"]),
    triggers: [String.raw`^compound interest\s+(?<principal>\d+(?:\.\d+)?)\s+(?<annualRatePercent>\d+(?:\.\d+)?)%?\s+(?<years>\d+(?:\.\d+)?)$`],
    tests: [
      { name: "annual compounding", input: { principal: 1000, annualRatePercent: 5, years: 10, compoundsPerYear: 1 }, expect: { finalBalance: 1628.89, totalContributed: 1000, interestEarned: 628.89 } },
      { name: "zero rate with contributions", input: { principal: 1000, annualRatePercent: 0, years: 5, monthlyContribution: 100 }, expect: { finalBalance: 7000, interestEarned: 0 } },
      { name: "negative principal rejected", input: { principal: -5, annualRatePercent: 5, years: 1 }, expectError: "principal" },
      { name: "missing years rejected", input: { principal: 5, annualRatePercent: 5 }, expectError: "years" },
    ],
    code: compoundInterest,
  },
  {
    slug: "ml.linear_regression", name: "Linear Regression", category: "Machine learning",
    description: "Fits y = slope*x + intercept by ordinary least squares, reports R-squared and optional predictions.",
    limitations: "Single feature, ordinary least squares only; sensitive to outliers.",
    inputSchema: obj({ x: { type: "array", minItems: 2, items: { type: "number" } }, y: { type: "array", minItems: 2, items: { type: "number" } }, predict: { type: "array", items: { type: "number" } } }, ["x", "y"]),
    outputSchema: obj({ slope: { type: "number" }, intercept: { type: "number" }, r2: { type: "number" } }, ["slope", "intercept", "r2"]),
    triggers: [],
    tests: [
      { name: "perfect line", input: { x: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] }, expect: { slope: 2, intercept: 0, r2: 1, n: 5 } },
      { name: "noisy data with prediction", input: { x: [1, 2, 3], y: [1, 3, 2], predict: [4] }, expect: { slope: 0.5, intercept: 1, r2: 0.25, predictions: [3] } },
      { name: "length mismatch", input: { x: [1, 2], y: [1] }, expectError: "same length" },
      { name: "constant x rejected", input: { x: [2, 2, 2], y: [1, 2, 3] }, expectError: "identical" },
    ],
    code: linearRegression,
  },
  {
    slug: "encode.base64", name: "Base64 Encoder/Decoder", category: "Programming",
    description: "Encodes UTF-8 text to Base64 and decodes it back with strict validation (hand-written, no Buffer).",
    limitations: "Standard Base64 alphabet only (no URL-safe variant); text input up to 100 KB.",
    inputSchema: obj({ mode: { type: "string", enum: ["encode", "decode"] }, text: { type: "string" } }, ["mode", "text"]),
    outputSchema: obj({ mode: { type: "string" }, output: { type: "string" } }, ["output"]),
    triggers: [String.raw`^base64\s+(?<mode>encode|decode)[:\s]+(?<text>.+)$`],
    tests: [
      { name: "encode ascii", input: { mode: "encode", text: "Hello" }, expect: { output: "SGVsbG8=" } },
      { name: "decode ascii", input: { mode: "decode", text: "SGVsbG8=" }, expect: { output: "Hello" } },
      { name: "utf-8 round trip", input: { mode: "decode", text: "w6k=" }, expect: { output: "é" } },
      { name: "encode empty", input: { mode: "encode", text: "" }, expect: { output: "" } },
      { name: "invalid base64 rejected", input: { mode: "decode", text: "!!!" }, expectError: "invalid base64" },
      { name: "invalid mode rejected", input: { mode: "zip", text: "x" }, expectError: "mode must be" },
    ],
    code: base64,
  },
];
