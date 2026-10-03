// Tests for geo_map.js — the embedded Gaode-tile map tab (2026-09-28).
// VM-blob pattern (like test_settings_login_field.js): geo_export.js and
// geo_map.js are classic scripts sharing globals in the browser, so the test
// loads both sources into one VM context with browser stubs.
// Run: node test_geo_map.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'geo_export.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(__dirname, 'geo_map.js'), 'utf8');

let store = {};
const localStorageStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
function mkEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() {}, remove() {}, contains() { return false; } } };
}
const els = {};
const context = {
  document: {
    getElementById: (id) => els[id] || (els[id] = mkEl(id)),
    addEventListener: () => {}, createElement: () => mkEl('tmp'),
    querySelector: () => null, querySelectorAll: () => []
  },
  localStorage: localStorageStub,
  navigator: { userAgent: 'test' },
  window: {}, console, Math, JSON, Date, Number, String, Array, Object, isNaN,
  encodeURIComponent, decodeURIComponent,
  __resetStore: () => { store = {}; },
  __setStore: (k, v) => { store[k] = v; },
  __pass: 0, __fail: 0,
  report(name, cond) { if (cond) { context.__pass++; console.log('  PASS', name); } else { context.__fail++; console.log('  FAIL', name); } }
};
vm.createContext(context);

const driver = `
${src}

(function runTests() {
  // ---- buildStudentPoints ----
  var students = [
    { id: 's1', fullName: 'A', geo: { lat: 25.0458, lng: 102.7101, capturedAt: '2026-09-27T01:00:00Z', days: 4, samples: 6 } },
    { id: 's2', fullName: 'B', geo: { lat: 25.05, lng: null } },          // unusable lng
    { id: 's3', fullName: 'C' },                                          // no geo
    { id: 's4', fullName: 'D', geo: { lat: 24.90, lng: 102.80, capturedAt: '2026-09-26T01:00:00Z', days: 1, samples: 1 } }
  ];
  var pts = buildStudentPoints(students);
  report('filters unusable geo docs', pts.length === 2 && pts[0].id === 's1' && pts[1].id === 's4');
  report('keeps confidence fields + name', pts[0].days === 4 && pts[0].samples === 6 && pts[0].name === 'A');
  report('gcj conversion applied (published eviltransform values for Kunming)',
    Math.abs(pts[0].lat - 25.04282499004523) < 1e-9 && Math.abs(pts[0].lng - 102.71153753988237) < 1e-9);

  // ---- haversineKm ----
  report('same point = 0 km', haversineKm(25.04, 102.71, 25.04, 102.71) === 0);
  var north = haversineKm(25.04, 102.71, 25.13, 102.71); // ~0.09 deg lat ~ 10.0 km
  report('0.09 deg lat ~ 10 km (got ' + north.toFixed(2) + ')', north > 9.8 && north < 10.2);
  report('symmetric', Math.abs(haversineKm(25.04, 102.71, 24.90, 102.80) - haversineKm(24.90, 102.80, 25.04, 102.71)) < 1e-9);

  // ---- rankCampuses ----
  var ring = [];
  var offs = [[25.05, 102.7], [25.05, 102.72], [25.03, 102.7], [25.03, 102.72]]; // clean literals — no float drift in URL asserts
  for (var i = 0; i < 4; i++) {
    ring.push({ id: 'r' + i, name: 'R' + i, days: 2, samples: 2, capturedAt: 'x',
      lat: offs[i][0], lng: offs[i][1] });
  }
  var camps = [
    { name: 'Near', lat: 25.04, lng: 102.71 },
    { name: 'Far',  lat: 25.20, lng: 102.71 }
  ];
  var ranked = rankCampuses(camps, ring);
  report('one entry per campus', ranked.length === 2);
  var near = ranked[0], far = ranked[1];
  report('near campus avg ~1.5km, all within 3km', near.avgKm > 1 && near.avgKm < 2 && near.within3 === 4 && near.within5 === 4);
  report('far campus avg > 15km, none within 5km', far.avgKm > 15 && far.within5 === 0);
  report('median computed', typeof near.medKm === 'number' && near.medKm > 1 && near.medKm < 2);
  report('rows carry student + km + drive link', near.rows.length === 4 && near.rows[0].name && near.rows[0].km >= 0 && near.rows[0].driveUrl.indexOf('uri.amap.com/navigation') === 8);
  report('driveUrl goes student -> campus (commute direction)',
    near.rows[0].driveUrl.indexOf('from=102.7,25.05,R0') > 0 && near.rows[0].driveUrl.indexOf('to=102.71,25.04,Near') > 0);

  // ---- gaodeDriveUrl ----
  var u = gaodeDriveUrl({ lat: 25.04, lng: 102.71 }, { lat: 24.90, lng: 102.80 }, 'Campus A', 'Li "Lily"');
  report('uri.amap.com + mode=car', u.indexOf('https://uri.amap.com/navigation?') === 0 && u.indexOf('mode=car') > 0);
  report('lng,lat order in from/to', u.indexOf('https://uri.amap.com/navigation?from=102.71,25.04,') === 0 && u.indexOf('to=102.8,24.9,') > 0);
  report('names URL-encoded (quotes/spaces)', u.indexOf('Li%20%22Lily%22') > 0 && u.indexOf('Campus%20A') > 0);

  // ---- campus pin persistence ----
  __resetStore();
  report('no pins -> empty array', Array.isArray(loadGeoCampusPins()) && loadGeoCampusPins().length === 0);
  saveGeoCampusPins([{ name: 'C1', lat: 25.04, lng: 102.71 }]);
  var back = loadGeoCampusPins();
  report('round-trips pins', back.length === 1 && back[0].name === 'C1');
  __setStore('csGeoCampusPins', '{broken');
  report('corrupt storage -> empty, no throw', loadGeoCampusPins().length === 0);
})();
`;

vm.runInContext(driver, context);
console.log(`\n${context.__pass} passed, ${context.__fail} failed`);
if (context.__fail > 0) process.exit(1);
