// ============================================================================
// geo_map.js — embedded Gaode (AMap) tile map for the teacher dashboard
// (2026-09-28). Shows every student with location data as one dot on a single
// map, lets the teacher drop candidate-campus pins, ranks campuses by
// straight-line distance, and opens REAL Gaode driving directions per pair via
// the key-less uri.amap.com deep link (Gaode's routing API needs a Chinese
// real-name-verified key — unobtainable here; see wiki 09/15).
//
// Loaded AFTER geo_export.js (classic script): reuses its wgs84ToGcj02 (Gaode
// tiles are GCJ-02, so dots must be converted to align with roads),
// _hasUsableFix and _esc. Leaflet is vendored at lib/leaflet/.
// Pure builders are VM-tested by test_geo_map.js; the Leaflet wiring is thin.
// ============================================================================

var GEO_MAP_PINS_KEY = 'csGeoCampusPins';
var GEO_MAP_TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';

// Students with a usable fix -> map points in GCJ-02 (tile space; Gaode tiles
// are GCJ-02 so dots align with roads). Distances and deep links are computed
// in the same space.
function buildStudentPoints(students) {
    return (students || [])
        .filter(function (s) { return _hasUsableFix(s && s.geo); })
        .map(function (s) {
            var g = s.geo;
            var gcj = wgs84ToGcj02(Number(g.lat), Number(g.lng));
            return {
                id: s.id,
                name: _studentName(s),
                days: g.days === undefined || g.days === null ? null : g.days,
                samples: g.samples === undefined || g.samples === null ? null : g.samples,
                capturedAt: g.capturedAt || '',
                lat: gcj[0], lng: gcj[1]
            };
        });
}

function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Key-less Gaode driving-directions deep link (GCJ-02 coords, lng,lat order).
// Opens the Gaode web planner / hands off to the phone app.
function gaodeDriveUrl(from, to, fromName, toName) {
    return 'https://uri.amap.com/navigation?from=' + from.lng + ',' + from.lat + ',' + encodeURIComponent(fromName || '') +
        '&to=' + to.lng + ',' + to.lat + ',' + encodeURIComponent(toName || '') +
        '&mode=car&src=classroom-survivors&coordinate=gaode&call=native';
}

function _median(sorted) {
    if (!sorted.length) return 0;
    var m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Per-campus straight-line ranking + per-student rows with drive links.
// All math in GCJ-02 space: campus pins arrive from map clicks (GCJ) and the
// Gaode deep link expects GCJ; the GCJ shift is a smooth local offset so
// GCJ-to-GCJ distances equal true distances to within a few metres.
function rankCampuses(campuses, points) {
    return (campuses || []).map(function (c) {
        var kms = [];
        var rows = (points || []).map(function (p) {
            var km = haversineKm(c.lat, c.lng, p.lat, p.lng);
            kms.push(km);
            // Commute direction: home -> campus (that's the trip students make).
            return { id: p.id, name: p.name, km: km, driveUrl: gaodeDriveUrl(p, c, p.name, c.name) };
        });
        kms.sort(function (a, b) { return a - b; });
        return {
            name: c.name, lat: c.lat, lng: c.lng, n: rows.length,
            avgKm: kms.length ? kms.reduce(function (a, b) { return a + b; }, 0) / kms.length : 0,
            medKm: _median(kms),
            within3: kms.filter(function (k) { return k <= 3; }).length,
            within5: kms.filter(function (k) { return k <= 5; }).length,
            rows: rows
        };
    });
}

function loadGeoCampusPins() {
    try {
        var v = JSON.parse(localStorage.getItem(GEO_MAP_PINS_KEY) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}
function saveGeoCampusPins(pins) {
    try { localStorage.setItem(GEO_MAP_PINS_KEY, JSON.stringify(pins || [])); } catch (e) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Leaflet wiring (browser only)
// ---------------------------------------------------------------------------
var _geoMap = null, _geoStudentLayer = null, _geoCampusLayer = null, _geoAddingCampus = false, _geoLastFit = '';

function _geoMapInit() {
    if (_geoMap) return _geoMap;
    L.Icon.Default.imagePath = 'lib/leaflet/images/';
    _geoMap = L.map('geoMapCanvas', { zoomControl: true });
    L.tileLayer(GEO_MAP_TILE_URL, {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        attribution: '&copy; 高德地图 (tiles, key-less raster endpoint)'
    }).addTo(_geoMap);
    _geoStudentLayer = L.layerGroup().addTo(_geoMap);
    _geoCampusLayer = L.layerGroup().addTo(_geoMap);
    _geoMap.on('click', function (e) {
        if (!_geoAddingCampus) return;
        var name = prompt('校区名称:', '候选' + (loadGeoCampusPins().length + 1));
        _geoAddingCampus = false;
        _geoMap.getContainer().style.cursor = '';
        if (!name) return;
        var pins = loadGeoCampusPins();
        pins.push({ name: name, lat: e.latlng.lat, lng: e.latlng.lng });
        saveGeoCampusPins(pins);
        renderGeoMap();
    });
    _geoMap.setView([25.04, 102.71], 11); // Kunming
    return _geoMap;
}

function geoMapAddCampusMode() {
    _geoAddingCampus = !_geoAddingCampus;
    var st = document.getElementById('geoMapStatus');
    if (st) st.textContent = _geoAddingCampus ? '在地图上点击候选校区位置…' : '';
    if (_geoMap) _geoMap.getContainer().style.cursor = _geoAddingCampus ? 'crosshair' : '';
}

function geoMapClearCampuses() {
    saveGeoCampusPins([]);
    renderGeoMap();
}

function geoMapSelectCampus(i) {
    renderGeoMap(Number(i));
}

function renderGeoMap(selectedIdx) {
    var canvas = typeof document !== 'undefined' && document.getElementById('geoMapCanvas');
    if (!canvas || typeof allStudents === 'undefined' || typeof L === 'undefined') return;
    var map = _geoMapInit();
    var points = buildStudentPoints(allStudents);
    var pins = loadGeoCampusPins();

    _geoStudentLayer.clearLayers();
    points.forEach(function (p) {
        var m = L.circleMarker([p.lat, p.lng], { radius: 6, color: '#d97706', fillColor: '#f59e0b', fillOpacity: 0.85, weight: 2 });
        m.bindPopup('<b>' + _esc(p.name) + '</b><br>days: ' + (p.days === null ? '-' : p.days) +
            ' · captured: ' + _esc(String(p.capturedAt).slice(0, 10)));
        m.bindTooltip(_esc(p.name) + (p.days > 1 ? ' (' + p.days + 'd)' : ''), { direction: 'top', offset: [0, -6] });
        _geoStudentLayer.addLayer(m);
    });

    _geoCampusLayer.clearLayers();
    pins.forEach(function (c) {
        var m = L.marker([c.lat, c.lng]);
        m.bindTooltip(_esc(c.name), { direction: 'top', offset: [0, -20] });
        _geoCampusLayer.addLayer(m);
    });

    var fitBounds = null;
    if (points.length || pins.length) {
        fitBounds = L.latLngBounds(points.concat(pins).map(function (p) { return [p.lat, p.lng]; }));
    }
    // Defer sizing+fit: on first render the container may not be laid out yet,
    // and fitBounds against a zero-size map computes zoom 0. Re-fit only when
    // the data bounds actually change, so selecting a campus keeps the view.
    setTimeout(function () {
        map.invalidateSize();
        if (fitBounds) {
            var bbox = fitBounds.toBBoxString();
            if (bbox !== _geoLastFit) {
                map.fitBounds(fitBounds.pad(0.15));
                _geoLastFit = bbox;
            }
        }
    }, 0);

    var cov = document.getElementById('geoMapCoverage');
    if (cov) cov.textContent = points.length + '/' + ((allStudents || []).length) + ' students plotted';

    var ranked = rankCampuses(pins, points);
    var idx = (selectedIdx === undefined || selectedIdx === null || !ranked[selectedIdx]) ? 0 : selectedIdx;
    var panel = document.getElementById('geoMapPanel');
    if (!panel) return;
    if (!ranked.length) {
        panel.innerHTML = '<p class="hint">尚无候选校区 — 点「添加候选校区」后在地图上点击落点。</p>';
        return;
    }
    var html = '<table class="dash-table compact"><thead><tr><th>校区</th><th>平均km</th><th>中位km</th><th>≤3km</th><th>≤5km</th></tr></thead><tbody>';
    ranked.forEach(function (r, i) {
        html += '<tr' + (i === idx ? ' style="background:rgba(255,255,255,.06)"' : '') + ' onclick="geoMapSelectCampus(' + i + ')" style="cursor:pointer"><td>' + _esc(r.name) +
            '</td><td>' + r.avgKm.toFixed(1) + '</td><td>' + r.medKm.toFixed(1) + '</td><td>' + r.within3 + '/' + r.n + '</td><td>' + r.within5 + '/' + r.n + '</td></tr>';
    });
    html += '</tbody></table>';
    var sel = ranked[idx];
    html += '<h4 style="margin:10px 0 4px">' + _esc(sel.name) + ' → 各学生（直线km / 高德驾车）</h4>';
    html += '<table class="dash-table compact"><thead><tr><th>学生</th><th>km</th><th></th></tr></thead><tbody>';
    sel.rows.slice().sort(function (a, b) { return a.km - b.km; }).forEach(function (row) {
        html += '<tr><td>' + _esc(row.name) + '</td><td>' + row.km.toFixed(1) +
            '</td><td><a href="' + row.driveUrl + '" target="_blank" rel="noopener">驾车</a></td></tr>';
    });
    panel.innerHTML = html + '</tbody></table>';
}
