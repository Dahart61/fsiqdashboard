/**
 * ═══════════════════════════════════════════════════════════════
 * FLEETSOURCE SPOTTER IQ — v3.9 Production
 * Geotab Add-in: geotab.addin.spotterIQ
 *
 * Five Operational States:
 *   MOVING        Green    RPM>400 · Spd>1 · Jaw:1
 *   BOBTAILING    Yellow   RPM>400 · Spd>1 · Jaw:0
 *   COUPLED_IDLE  Orange   RPM>400 · Spd<1 · Jaw:1
 *   BOBTAIL_IDLE  Red      RPM>400 · Spd<1 · Jaw:0
 *   OFF           Dark     RPM<400
 *
 * Sensor Fidelity:
 *   JAW SENSOR    IOX-AUXM reporting — full five-state
 *   RPM ONLY      No IOX — engine on/off only
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // ══════════════════════════════════════════════════════════
    //  CONSTANTS & STATE DEFINITIONS
    // ══════════════════════════════════════════════════════════

    var STATES = {
        MOVING:       { key: 'MOVING',       label: 'Moving',       css: 'moving',       color: '#16a34a', tip: 'Engine On, Speed > 1 mph, Trailer Coupled.' },
        BOBTAILING:   { key: 'BOBTAILING',   label: 'Bobtailing',   css: 'bobtailing',   color: '#ca8a04', tip: 'Engine On, Speed > 1 mph, No Trailer detected.' },
        COUPLED_IDLE: { key: 'COUPLED_IDLE', label: 'Coupled Idle', css: 'coupled-idle', color: '#ea580c', tip: 'Engine On, Speed < 1 mph, Trailer Coupled.' },
        BOBTAIL_IDLE: { key: 'BOBTAIL_IDLE', label: 'Bobtail Idle', css: 'bobtail-idle', color: '#dc2626', tip: 'Engine On, Speed < 1 mph, No Trailer detected.' },
        OFF:          { key: 'OFF',          label: 'Off',          css: 'off',          color: '#374151', tip: 'Engine Off (RPM < 400).' }
    };
    var STATE_ORDER = ['MOVING', 'BOBTAILING', 'COUPLED_IDLE', 'BOBTAIL_IDLE', 'OFF'];
    var SLOT_LABELS = ['4–8 AM', '8 AM–12 PM', '12–4 PM', '4–8 PM', '8 PM–12 AM', '12–4 AM'];

    // Geotab Diagnostic IDs (for reference / future wiring)
    var DIAG = {
        AUX1:              'DiagnosticAuxiliary1Id',        // Jaw Proximity Sensor
        SPEED:             'DiagnosticVehicleSpeedId',
        RPM:               'DiagnosticEngineSpeedId',
        FUEL_USED:         'DiagnosticTotalFuelUsedId',     // Cumulative injector fuel (liters)
        ENGINE_HOURS:      'DiagnosticEngineHoursId',       // Cumulative engine hours
        FUEL_LEVEL:        'DiagnosticFuelLevelId',
        DEF_LEVEL:         'DiagnosticDieselExhaustFluidId'
    };

    // Unit conversions
    var KPH_TO_MPH = 0.621371;
    var LITERS_TO_GAL = 0.264172;

    // Operational day boundary
    var OP_DAY_START_HOUR = 4; // 4:00 AM

    // 4-hour checkpoint targets
    var CHECKPOINTS = [4, 8, 12, 16, 20, 0]; // hours

    // ══════════════════════════════════════════════════════════
    //  SEEDED RANDOM (stable mock data)
    // ══════════════════════════════════════════════════════════

    function seeded(s) {
        var x = s;
        return function () {
            x = (x * 16807) % 2147483647;
            return (x - 1) / 2147483646;
        };
    }

    // ══════════════════════════════════════════════════════════
    //  SAMPLE FLEET DATA
    // ══════════════════════════════════════════════════════════

    var TRUCKS = [
        { id: 'YT-101', name: 'YT-101', sensorOk: true },
        { id: 'YT-102', name: 'YT-102', sensorOk: true },
        { id: 'YT-103', name: 'YT-103', sensorOk: false },
        { id: 'YT-104', name: 'YT-104', sensorOk: true },
        { id: 'YT-105', name: 'YT-105', sensorOk: true },
        { id: 'YT-106', name: 'YT-106', sensorOk: false },
        { id: 'YT-107', name: 'YT-107', sensorOk: true },
        { id: 'YT-108', name: 'YT-108', sensorOk: true }
    ];

    // ══════════════════════════════════════════════════════════
    //  TOOLTIP SYSTEM
    // ══════════════════════════════════════════════════════════

    var tooltipEl = null;

    function initTooltip() {
        tooltipEl = document.getElementById('tooltip');
    }

    function attachTip(el, text) {
        el.addEventListener('mouseenter', function (e) {
            var rect = el.getBoundingClientRect();
            tooltipEl.textContent = text;
            tooltipEl.style.left = (rect.left + rect.width / 2) + 'px';
            tooltipEl.style.top = (rect.top - 6) + 'px';
            tooltipEl.style.transform = 'translate(-50%, -100%)';
            tooltipEl.classList.add('tooltip--visible');
        });
        el.addEventListener('mouseleave', function () {
            tooltipEl.classList.remove('tooltip--visible');
        });
    }

    // ══════════════════════════════════════════════════════════
    //  UTILITY: HTML HELPERS
    // ══════════════════════════════════════════════════════════

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    function gphClass(v) {
        return v < 2.0 ? 'green' : v <= 3.0 ? 'amber' : 'red';
    }
    function gphColor(v) {
        return v < 2.0 ? '#16a34a' : v <= 3.0 ? '#ca8a04' : '#dc2626';
    }
    function gphTag(v) {
        return v < 2.0 ? 'EFFICIENT' : v <= 3.0 ? 'MONITOR' : 'OVER LIMIT';
    }

    function sensorBadgeHTML(ok) {
        if (ok) {
            return '<span class="badge-sensor badge-sensor--jaw" data-tip="IOX-AUXM Jaw Proximity Sensor reporting. Full five-state classification available.">' +
                   '<span class="badge-sensor__dot"></span>JAW SENSOR</span>';
        }
        return '<span class="badge-sensor badge-sensor--rpm" data-tip="No IOX-AUXM detected. Running on engine RPM data only. Cannot distinguish coupled vs. bobtail states.">' +
               '<span class="badge-sensor__dot"></span>RPM ONLY</span>';
    }

    function stateBadgeHTML(stateKey, isFallback, isOffline, checkSensor) {
        if (isOffline) {
            return '<span class="badge-state badge-state--offline" data-tip="No device communication for 7+ days. Check GO9 power connection or confirm asset is in storage.">' +
                   '<span class="badge-state__dot"></span>OFFLINE</span>';
        }
        if (checkSensor) {
            return '<span class="badge-state badge-state--check-sensor" data-tip="Ignition ON >2 hours, exceeded 10 mph 5+ times, but jaw sensor stuck at 0. Possible IOX-AUXM failure.">' +
                   '<span class="badge-state__dot"></span>CHECK SENSOR</span>';
        }
        if (isFallback) {
            var isOn = stateKey !== 'OFF';
            var cls = isOn ? 'badge-state--fallback-on' : 'badge-state--fallback-off';
            var lbl = isOn ? 'Engine On' : 'Off';
            var tip = isOn ? 'Engine running (RPM > 400). No jaw sensor — cannot determine trailer coupling state.' : 'Engine Off (RPM < 400).';
            return '<span class="badge-state ' + cls + '" data-tip="' + tip + '">' +
                   '<span class="badge-state__dot"></span>' + lbl + '</span>';
        }
        var st = STATES[stateKey];
        return '<span class="badge-state badge-state--' + st.css + '" data-tip="' + st.tip + '">' +
               '<span class="badge-state__dot"></span>' + st.label + '</span>';
    }

    // Wire all [data-tip] elements inside a container
    function wireTips(container) {
        var items = container.querySelectorAll('[data-tip]');
        for (var i = 0; i < items.length; i++) {
            attachTip(items[i], items[i].getAttribute('data-tip'));
        }
    }

    // ══════════════════════════════════════════════════════════
    //  FIVE-STATE LEGEND BUILDER
    // ══════════════════════════════════════════════════════════

    function buildLegend(container, showFallback) {
        container.innerHTML = '';
        STATE_ORDER.forEach(function (k) {
            var st = STATES[k];
            var item = el('span', 'legend__item');
            item.innerHTML = '<span class="legend__swatch" style="background:' + st.color + '"></span>' +
                             '<span style="color:' + st.color + ';font-weight:700">' + st.label + '</span>';
            item.setAttribute('data-tip', st.tip);
            container.appendChild(item);
        });
        if (showFallback) {
            var fb = el('span', 'legend__fallback');
            fb.innerHTML = '<span class="legend__hatch-swatch"></span>' +
                           '<span style="color:#ca8a04;font-weight:700">RPM Only Fallback</span>';
            fb.setAttribute('data-tip', 'No IOX-AUXM jaw sensor detected. Engine Hours and Fuel data are valid, but coupled/bobtail split is unavailable.');
            container.appendChild(fb);
        }
        wireTips(container);
    }

    // ══════════════════════════════════════════════════════════
    //  LEAF GROUP RESOLVER
    // ══════════════════════════════════════════════════════════

    /**
     * Finds the lowest-level (leaf) group the current user's
     * devices belong to. Falls back to first group name.
     *
     * STUB: Uses hardcoded value for mockup. Replace with:
     *   api.call('Get', { typeName: 'Group' })
     *   then walk the tree to find the deepest child.
     */
    function resolveLeafGroup(api, callback) {
        // ── LIVE WIRING (uncomment when connecting to Geotab) ──
        // api.call('Get', { typeName: 'Group' }, function (groups) {
        //     var leaf = findDeepestLeaf(groups);
        //     callback(leaf ? leaf.name : 'Fleet');
        // }, function () {
        //     callback('Fleet');
        // });

        // ── HARDCODED SAMPLE ──
        callback("BJ's Burlington");
    }

    // ══════════════════════════════════════════════════════════
    //  LIVE DATA GENERATOR (sample)
    // ══════════════════════════════════════════════════════════

    function generateLiveData(shiftHrs) {
        var now = new Date();
        var forced = ['MOVING', 'BOBTAILING', 'COUPLED_IDLE', 'BOBTAIL_IDLE', 'MOVING', null, 'COUPLED_IDLE', 'OFF'];

        return TRUCKS.map(function (truck, i) {
            var rand = seeded(i * 77 + shiftHrs + 3);
            var isOffline = truck.id === 'YT-108' && shiftHrs === 12;
            var minsAgo = isOffline ? 60 * 24 * 9 : Math.floor(rand() * 90);
            var lastSeen = new Date(now.getTime() - minsAgo * 60000);
            var daysOff = (now - lastSeen) / 864e5;

            if (daysOff > 7) {
                return { truck: truck, stateKey: 'OFF', moves: '--', lastSeen: lastSeen, fuelPct: '--', defPct: '--', engineHrs: '--', isOffline: true, checkSensor: false };
            }

            var ignH = +(1.5 + rand() * 5).toFixed(1);
            var hiSpd = Math.floor(rand() * 12);
            var checkSensor = truck.sensorOk && ignH > 2 && hiSpd >= 5 && (forced[i] === 'BOBTAIL_IDLE' || forced[i] === 'BOBTAILING');

            var stateKey;
            if (!truck.sensorOk) { stateKey = rand() > 0.3 ? 'BOBTAIL_IDLE' : 'OFF'; }
            else if (forced[i]) { stateKey = forced[i]; }
            else { var r = rand(); stateKey = r < 0.3 ? 'MOVING' : r < 0.5 ? 'BOBTAILING' : r < 0.7 ? 'COUPLED_IDLE' : r < 0.9 ? 'BOBTAIL_IDLE' : 'OFF'; }

            return {
                truck: truck,
                stateKey: stateKey,
                moves: stateKey === 'MOVING' ? Math.floor(4 + rand() * 20) : Math.floor(rand() * 6),
                lastSeen: lastSeen,
                fuelPct: Math.floor(15 + rand() * 80) + '%',
                defPct: Math.floor(25 + rand() * 70) + '%',
                engineHrs: +(400 + rand() * 3200).toFixed(1),
                isOffline: false,
                checkSensor: checkSensor
            };
        });
    }

    // ══════════════════════════════════════════════════════════
    //  HISTORICAL DATA GENERATORS (sample)
    // ══════════════════════════════════════════════════════════

    function generateTruckDay(truck, dayOff) {
        var rand = seeded(truck.id.charCodeAt(3) * 100 + dayOff * 7 + 42);
        var fb = !truck.sensorOk;

        var slots = SLOT_LABELS.map(function (label, si) {
            var offMin = Math.floor(rand() * (si === 5 ? 160 : 50));
            var on = 240 - offMin;
            var moving, bobtailing, coupledIdle, bobtailIdle;
            if (fb) { moving = 0; bobtailing = 0; coupledIdle = 0; bobtailIdle = on; }
            else {
                moving = Math.floor(on * (0.25 + rand() * 0.35));
                bobtailing = Math.floor(on * (0.02 + rand() * 0.12));
                coupledIdle = Math.floor(on * (0.05 + rand() * 0.15));
                bobtailIdle = Math.max(0, on - moving - bobtailing - coupledIdle);
            }
            var engH = +(on / 60).toFixed(1);
            var fuel = +(on / 60 * (1.3 + rand() * 2.0)).toFixed(1);
            var gph = engH > 0 ? +(fuel / engH).toFixed(1) : 0;
            return { label: label, offMin: offMin, moving: moving, bobtailing: bobtailing, coupledIdle: coupledIdle, bobtailIdle: bobtailIdle, engH: engH, fuel: fuel, gph: gph, fb: fb };
        });

        var sum = function (fn) { return slots.reduce(function (a, s) { return a + fn(s); }, 0); };
        var tEH = +sum(function (s) { return s.engH; }).toFixed(1);
        var tF = +sum(function (s) { return s.fuel; }).toFixed(1);
        var tIdleMin = sum(function (s) { return s.bobtailIdle; });
        var tOnMin = sum(function (s) { return s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle; });
        var idlePct = tOnMin > 0 ? +((tIdleMin / tOnMin) * 100).toFixed(0) : 0;
        var avgGph = tEH > 0 ? +(tF / tEH).toFixed(1) : 0;
        var waste = fb ? null : +(tIdleMin / 60 * (0.7 + seeded(dayOff + truck.id.charCodeAt(3))() * 0.5)).toFixed(1);
        var moves = fb ? null : Math.floor(8 + seeded(dayOff * 3 + truck.id.charCodeAt(3))() * 28);
        var maxSpd = +(8 + seeded(dayOff + truck.id.charCodeAt(3) * 2)() * 14).toFixed(0);

        return { truck: truck, slots: slots, tEH: tEH, tF: tF, idlePct: idlePct, avgGph: avgGph, waste: waste, moves: moves, maxSpd: maxSpd, fb: fb };
    }

    function generateFleetSummary() {
        return TRUCKS.map(function (truck) {
            var eH = 0, f = 0, w = 0, m = 0, ms = 0, ip = 0;
            for (var d = 0; d < 7; d++) {
                var day = generateTruckDay(truck, d);
                eH += day.tEH; f += day.tF;
                if (day.waste !== null) w += day.waste;
                if (day.moves !== null) m += day.moves;
                if (day.maxSpd > ms) ms = day.maxSpd;
                ip += day.idlePct;
            }
            return {
                truck: truck,
                avgGph: eH > 0 ? +(f / eH).toFixed(1) : 0,
                waste: truck.sensorOk ? +w.toFixed(1) : null,
                idlePct: +(ip / 7).toFixed(0),
                totalMoves: truck.sensorOk ? m : null,
                maxSpd: ms,
                tEH: +eH.toFixed(1),
                tF: +f.toFixed(1)
            };
        });
    }

    // ══════════════════════════════════════════════════════════
    //  TIERED FETCH STRATEGY (stubs for live wiring)
    // ══════════════════════════════════════════════════════════

    /**
     * Tier A — Boundary Snapshots
     * Fetches first/last StatusData reading within a window
     * for cumulative diagnostics (Fuel, Engine Hours).
     *
     * STUB: Returns hardcoded deltas. Replace internals with:
     *   api.multiCall([
     *     ['Get', { typeName: 'StatusData', search: {
     *       fromDate, toDate, deviceId, diagnosticId,
     *       resultsLimit: 1 // ascending = start, descending = end
     *     }}],
     *     ...
     *   ])
     */
    function fetchBoundarySnapshots(api, deviceId, fromDate, toDate, callback) {
        // Hardcoded sample deltas
        callback({
            fuelStartLiters: 14307.2,
            fuelEndLiters: 14331.8,
            engineHoursStart: 2401.3,
            engineHoursEnd: 2412.7,
            fuelDeltaGal: +((14331.8 - 14307.2) * LITERS_TO_GAL).toFixed(1),
            engineHoursDelta: +(2412.7 - 2401.3).toFixed(1)
        });
    }

    /**
     * Tier B — 4-Hour Checkpoint Fetch
     * For each checkpoint hour, fetch nearest StatusData record
     * for RPM, Fuel, Engine Hours within ±45 min window.
     *
     * STUB: Returns sample slot data. Replace with multicall
     * batches of 5-8 devices, 200ms throttle between batches.
     */
    function fetchCheckpointData(api, deviceId, opDayStart, callback) {
        // Return sample slot data for one truck/day
        callback(null); // null = use generated sample data
    }

    // ══════════════════════════════════════════════════════════
    //  FIVE-STATE CLASSIFIER (for live data wiring)
    // ══════════════════════════════════════════════════════════

    /**
     * Classifies a set of telemetry readings into one of five states.
     * @param {number} rpm - Engine RPM
     * @param {number} speedMph - Vehicle speed in MPH
     * @param {number|null} jawLocked - 1=locked, 0=unlocked, null=no sensor
     * @returns {string} State key
     */
    function classifyState(rpm, speedMph, jawLocked) {
        if (rpm < 400) return 'OFF';
        if (jawLocked === null) return 'BOBTAIL_IDLE'; // fallback: can't distinguish
        if (speedMph > 1 && jawLocked === 1) return 'MOVING';
        if (speedMph > 1 && jawLocked === 0) return 'BOBTAILING';
        if (speedMph <= 1 && jawLocked === 1) return 'COUPLED_IDLE';
        return 'BOBTAIL_IDLE';
    }

    /**
     * Check Sensor alert logic.
     * Returns true if ignition ON > 2h, exceeded 10mph 5+ times, jaw stuck at 0.
     */
    function shouldCheckSensor(ignOnHours, highSpeedCount, jawAlwaysZero) {
        return ignOnHours > 2 && highSpeedCount >= 5 && jawAlwaysZero;
    }

    /**
     * Completed Move logic.
     * A move counts only when Jaw=1 (locked) AND Speed > 2 mph.
     */
    function isCompletedMove(jawLocked, speedMph) {
        return jawLocked === 1 && speedMph > 2;
    }

    // ══════════════════════════════════════════════════════════
    //  RENDER: LIVE DISPATCHER TAB
    // ══════════════════════════════════════════════════════════

    var currentShift = 12;

    function renderLive() {
        var data = generateLiveData(currentShift);
        var tbody = document.getElementById('liveBody');
        tbody.innerHTML = '';

        data.forEach(function (row, idx) {
            var tr = document.createElement('tr');

            // Asset cell
            var tdAsset = el('td', '', '');
            tdAsset.innerHTML = '<div class="asset-cell">' +
                '<span class="asset-id">' + row.truck.name + '</span>' +
                sensorBadgeHTML(row.truck.sensorOk) +
                '</div>';

            // State cell
            var tdState = el('td', '', '');
            tdState.innerHTML = stateBadgeHTML(row.stateKey, !row.truck.sensorOk && !row.isOffline, row.isOffline, row.checkSensor);

            // Moves cell
            var tdMoves = el('td', '', '');
            if (row.moves === '--') {
                tdMoves.innerHTML = '<span class="text-faint">—</span>';
            } else {
                tdMoves.innerHTML = '<span class="move-count">' + row.moves + '</span>';
                if (!row.truck.sensorOk && !row.isOffline) {
                    tdMoves.innerHTML += '<div class="move-est">EST · RPM</div>';
                }
            }

            // Last Seen cell
            var tdSeen = el('td', '', '');
            var seenStr = row.lastSeen.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            if (row.isOffline) {
                tdSeen.innerHTML = '<span class="text-red text-bold" style="font-size:12px">' + seenStr + '</span>' +
                                   '<div class="offline-label">7+ DAYS — NO HEARTBEAT</div>';
            } else {
                tdSeen.innerHTML = '<span style="font-size:12px;color:#6b7280">' + seenStr + '</span>';
            }

            // Fuel / DEF cell
            var tdFuel = el('td', '', '');
            if (row.fuelPct === '--') {
                tdFuel.innerHTML = '<span class="text-faint">—</span>';
            } else {
                var fuelVal = parseInt(row.fuelPct);
                var fuelColor = fuelVal < 25 ? 'text-red text-bold' : 'text-bold';
                tdFuel.innerHTML = '<span class="' + fuelColor + '" style="font-size:13px">' + row.fuelPct + '</span>' +
                                   '<span class="text-muted" style="margin-left:12px;font-size:12px">' + row.defPct + '</span>';
            }

            // Engine Hours cell
            var tdEng = el('td', '', '');
            tdEng.innerHTML = row.engineHrs === '--'
                ? '<span class="text-faint">—</span>'
                : '<span style="font-size:13px;color:#6b7280">' + row.engineHrs + ' h</span>';

            tr.appendChild(tdAsset);
            tr.appendChild(tdState);
            tr.appendChild(tdMoves);
            tr.appendChild(tdSeen);
            tr.appendChild(tdFuel);
            tr.appendChild(tdEng);
            tbody.appendChild(tr);
        });

        wireTips(tbody);
        buildLegend(document.getElementById('liveLegend'), true);
    }

    // ══════════════════════════════════════════════════════════
    //  RENDER: HISTORICAL AUDIT TAB
    // ══════════════════════════════════════════════════════════

    var fleetSummary = null;
    var auditState = { view: 'fleet', truckId: null, day: 0 };

    function renderAuditFleet() {
        if (!fleetSummary) fleetSummary = generateFleetSummary();
        var fleet = fleetSummary;

        // KPI Cards
        var totalWaste = fleet.reduce(function (a, t) { return a + (t.waste || 0); }, 0).toFixed(1);
        var fleetGph = +(fleet.reduce(function (a, t) { return a + t.avgGph; }, 0) / fleet.length).toFixed(1);
        var totalEH = fleet.reduce(function (a, t) { return a + t.tEH; }, 0).toFixed(0);

        var kpiRow = document.getElementById('kpiCards');
        kpiRow.innerHTML = '';

        var cards = [
            { label: 'Total Waste Fuel', value: totalWaste, unit: 'gallons', color: '#dc2626', sub: 'Bobtail Idle fuel burn (sensor trucks)' },
            { label: 'Fleet Avg GPH', value: fleetGph, unit: 'gal/eng-hr', color: gphColor(fleetGph), sub: '< 2.0 efficient · 2.0–3.0 monitor · > 3.0 alert' },
            { label: 'Total Engine Hours', value: totalEH, unit: 'hours', color: '#0c4a6e', sub: 'All 8 assets combined' }
        ];
        cards.forEach(function (c) {
            var card = el('div', 'kpi-card');
            card.style.borderLeftColor = c.color;
            card.innerHTML = '<div class="kpi-card__label">' + c.label + '</div>' +
                '<div class="kpi-card__value">' +
                    '<span class="kpi-card__num" style="color:' + c.color + '">' + c.value + '</span>' +
                    '<span class="kpi-card__unit">' + c.unit + '</span>' +
                '</div>' +
                '<div class="kpi-card__sub">' + c.sub + '</div>';
            kpiRow.appendChild(card);
        });

        // Meta line
        document.getElementById('auditMeta').textContent = 'Jun 16 – Jun 22, 2025 · Operational Day: 4:00 AM – 3:59 AM · Click row to drill down';

        // Fleet table
        var tbody = document.getElementById('auditBody');
        tbody.innerHTML = '';

        fleet.forEach(function (row) {
            var tr = document.createElement('tr');
            tr.setAttribute('data-clickable', '1');
            tr.addEventListener('click', function () {
                auditState.truckId = row.truck.id;
                auditState.day = 0;
                auditState.view = 'drill';
                showAuditView();
            });

            var gc = gphClass(row.avgGph);

            tr.innerHTML =
                '<td><div class="asset-cell"><span class="asset-id" style="font-size:14px">' + row.truck.name + '</span>' + sensorBadgeHTML(row.truck.sensorOk) + '</div></td>' +
                '<td><span class="gph-pill gph-pill--' + gc + '">' + row.avgGph + '</span><div class="gph-tag" style="color:' + gphColor(row.avgGph) + '">' + gphTag(row.avgGph) + '</div></td>' +
                '<td style="font-weight:700;font-size:14px;color:' + (row.waste !== null ? '#dc2626' : '#bbb') + '">' + (row.waste !== null ? row.waste + ' gal' : '<span class="text-faint" style="font-size:11px;color:#ca8a04">N/A</span>') + '</td>' +
                '<td><span style="font-weight:700;font-size:14px;color:' + (row.idlePct > 50 ? '#dc2626' : row.idlePct > 35 ? '#ca8a04' : '#16a34a') + '">' + row.idlePct + '%</span></td>' +
                '<td style="font-weight:700;font-size:14px">' + (row.totalMoves !== null ? row.totalMoves : '<span class="text-faint" style="font-size:11px;color:#ca8a04">N/A</span>') + '</td>' +
                '<td><span style="font-weight:600;color:' + (row.maxSpd > 18 ? '#dc2626' : '#111827') + '">' + row.maxSpd + ' mph</span></td>' +
                '<td style="font-size:13px;color:#6b7280">' + row.tEH + ' h</td>' +
                '<td style="font-size:13px;color:#6b7280">' + row.tF + ' gal</td>';

            tbody.appendChild(tr);
        });

        wireTips(tbody);
        buildLegend(document.getElementById('auditLegend'), true);
    }

    // ── DRILL-DOWN RENDERER ────────────────────────────────────

    function renderDrillDown() {
        var truck = TRUCKS.filter(function (t) { return t.id === auditState.truckId; })[0];
        var data = generateTruckDay(truck, auditState.day);

        // Day bar
        var dayBar = document.getElementById('dayBar');
        dayBar.innerHTML = '';
        for (var d = 0; d < 7; d++) {
            var dt = new Date(2025, 5, 16 + d);
            var btn = el('button', 'day-btn' + (d === auditState.day ? ' day-btn--active' : ''));
            btn.textContent = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            btn.setAttribute('data-day', d);
            btn.addEventListener('click', function () {
                auditState.day = parseInt(this.getAttribute('data-day'));
                renderDrillDown();
            });
            dayBar.appendChild(btn);
        }

        // Header
        var dtLabel = new Date(2025, 5, 16 + auditState.day);
        document.getElementById('drillTruckName').innerHTML =
            '<span>' + truck.name + '</span>' + sensorBadgeHTML(truck.sensorOk);
        document.getElementById('drillDate').innerHTML =
            '<strong>' + dtLabel.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + '</strong>' +
            '<span class="drill__date-range">4:00 AM – 3:59 AM</span>';

        // KPIs
        var kpis = document.getElementById('drillKpis');
        var kpiData = [
            { l: 'GPH', v: data.avgGph, c: gphColor(data.avgGph), bg: gphColor(data.avgGph).replace(')', ',0.07)').replace('rgb', 'rgba') },
            { l: 'Waste Fuel', v: data.waste !== null ? data.waste + ' gal' : '—', c: data.waste !== null ? '#dc2626' : '#bbb', bg: 'rgba(220,38,38,0.05)' },
            { l: 'Eng Hrs', v: data.tEH + ' h', c: '#0c4a6e', bg: 'rgba(12,74,110,0.05)' },
            { l: 'Fuel', v: data.tF + ' gal', c: '#111827', bg: '#f9fafb' },
            { l: 'Idle %', v: data.idlePct + '%', c: data.idlePct > 50 ? '#dc2626' : data.idlePct > 35 ? '#ca8a04' : '#16a34a', bg: '#f9fafb' }
        ];
        kpis.innerHTML = kpiData.map(function (k) {
            return '<div class="drill-kpi" style="background:' + k.bg + '">' +
                   '<div class="drill-kpi__label">' + k.l + '</div>' +
                   '<div class="drill-kpi__val" style="color:' + k.c + '">' + k.v + '</div></div>';
        }).join('');

        // Ribbon axis
        var axis = document.getElementById('ribbonAxis');
        axis.innerHTML = SLOT_LABELS.map(function (l) {
            return '<span class="ribbon__axis-label">' + l + '</span>';
        }).join('');

        // Activity Ribbon
        var ribbon = document.getElementById('ribbon');
        ribbon.innerHTML = '';
        data.slots.forEach(function (s) {
            var slot = el('div', 'ribbon__slot');
            var t = 240;

            if (s.fb) {
                // Hatched fallback
                var onPct = ((s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle) / t) * 100;
                slot.innerHTML =
                    '<svg width="100%" height="' + onPct + '%" style="display:block;min-height:' + (onPct > 0 ? '4px' : '0') + '" data-tip="RPM Only — no jaw sensor data. Cannot split coupled/bobtail states."><rect width="100%" height="100%" fill="url(#hatch)"/></svg>' +
                    '<div style="flex:1;background:#374151;opacity:0.18"></div>' +
                    '<div class="ribbon__gph">—</div>';
            } else {
                var segs = [
                    { min: s.moving, cls: 'moving', st: 'MOVING' },
                    { min: s.bobtailing, cls: 'bobtailing', st: 'BOBTAILING' },
                    { min: s.coupledIdle, cls: 'coupled-idle', st: 'COUPLED_IDLE' },
                    { min: s.bobtailIdle, cls: 'bobtail-idle', st: 'BOBTAIL_IDLE' },
                    { min: s.offMin, cls: 'off', st: 'OFF' }
                ];
                var html = '';
                segs.forEach(function (seg) {
                    var pct = (seg.min / t) * 100;
                    if (pct > 0) {
                        var tipText = STATES[seg.st].label + ': ' + seg.min + 'm — ' + STATES[seg.st].tip;
                        html += '<div class="ribbon__seg ribbon__seg--' + seg.cls + '" style="height:' + pct + '%" data-tip="' + tipText + '"></div>';
                    }
                });
                html += '<div class="ribbon__gph">' + s.gph + '</div>';
                slot.innerHTML = html;
            }
            ribbon.appendChild(slot);
        });

        // Slot bar & detail
        renderSlotBar(data);
        renderSlotDetail(data, 0);

        // Fallback banner
        var banner = document.getElementById('fallbackBanner');
        if (data.fb) { banner.classList.remove('fallback-banner--hidden'); }
        else { banner.classList.add('fallback-banner--hidden'); }

        // Legend
        buildLegend(document.getElementById('drillLegend'), data.fb);

        // Wire all tooltips in the drill card
        wireTips(document.getElementById('drillCard'));
        wireTips(document.getElementById('drillTruckName'));
    }

    function renderSlotBar(data) {
        var bar = document.getElementById('slotBar');
        bar.innerHTML = '';
        data.slots.forEach(function (s, i) {
            var btn = el('button', 'slot-btn' + (i === 0 ? ' slot-btn--active' : ''));
            btn.textContent = s.label;
            btn.setAttribute('data-slot', i);
            btn.addEventListener('click', function () {
                var idx = parseInt(this.getAttribute('data-slot'));
                bar.querySelectorAll('.slot-btn').forEach(function (b) { b.classList.remove('slot-btn--active'); });
                this.classList.add('slot-btn--active');
                renderSlotDetail(data, idx);
            });
            bar.appendChild(btn);
        });
    }

    function renderSlotDetail(data, idx) {
        var s = data.slots[idx];
        var panel = document.getElementById('slotDetail');
        var onMin = s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle;

        var metricsHTML =
            '<div class="slot-detail__metrics">' +
                '<div><div class="slot-metric__label">GPH</div>' +
                '<div class="slot-metric__val" style="color:' + (s.fb ? '#9ca3af' : gphColor(s.gph)) + '">' + (s.fb ? '—' : s.gph) + '</div></div>' +
                '<div><div class="slot-metric__label">Fuel</div>' +
                '<div class="slot-metric__val" style="color:#111827">' + s.fuel + ' <span style="font-size:12px;color:#9ca3af">gal</span></div></div>' +
                '<div><div class="slot-metric__label">Eng Hrs</div>' +
                '<div class="slot-metric__val" style="color:#111827">' + s.engH + ' <span style="font-size:12px;color:#9ca3af">h</span></div></div>';

        if (s.fb) {
            metricsHTML += '<div class="slot-fallback-tag"><span class="slot-fallback-tag__dot"></span>RPM ONLY — No State Split</div>';
        }
        metricsHTML += '</div>';

        var statesHTML = '';
        if (!s.fb) {
            var chips = [
                { l: 'Moving', min: s.moving, c: STATES.MOVING.color, tip: STATES.MOVING.tip },
                { l: 'Bobtailing', min: s.bobtailing, c: STATES.BOBTAILING.color, tip: STATES.BOBTAILING.tip },
                { l: 'Coupled Idle', min: s.coupledIdle, c: STATES.COUPLED_IDLE.color, tip: STATES.COUPLED_IDLE.tip },
                { l: 'Bobtail Idle', min: s.bobtailIdle, c: STATES.BOBTAIL_IDLE.color, tip: STATES.BOBTAIL_IDLE.tip },
                { l: 'Off', min: s.offMin, c: STATES.OFF.color, tip: STATES.OFF.tip }
            ];
            statesHTML = '<div class="slot-detail__states">';
            chips.forEach(function (ch) {
                statesHTML += '<div class="slot-state-chip" data-tip="' + ch.tip + '">' +
                    '<span class="slot-state-chip__swatch" style="background:' + ch.c + '"></span>' +
                    '<span class="slot-state-chip__label">' + ch.l + '</span>' +
                    '<span class="slot-state-chip__min">' + ch.min + 'm</span></div>';
            });
            statesHTML += '</div>';
        } else {
            statesHTML = '<div class="slot-fallback-text">Engine On: ' + onMin + 'm · Off: ' + s.offMin + 'm — Five-state split requires JAW SENSOR.</div>';
        }

        panel.innerHTML = metricsHTML + statesHTML;
        wireTips(panel);
    }

    // ══════════════════════════════════════════════════════════
    //  VIEW SWITCHING
    // ══════════════════════════════════════════════════════════

    var activeTab = 'live';

    function switchTab(tab) {
        activeTab = tab;
        document.getElementById('viewLive').classList.toggle('view--hidden', tab !== 'live');
        document.getElementById('viewAudit').classList.toggle('view--hidden', tab !== 'audit');
        document.getElementById('tabLive').classList.toggle('tab-bar__btn--active', tab === 'live');
        document.getElementById('tabAudit').classList.toggle('tab-bar__btn--active', tab === 'audit');

        if (tab === 'live') renderLive();
        if (tab === 'audit') {
            auditState.view = 'fleet';
            showAuditView();
        }
    }

    function showAuditView() {
        var isFleet = auditState.view === 'fleet';
        document.getElementById('auditFleet').style.display = isFleet ? '' : 'none';
        document.getElementById('auditDrill').classList.toggle('drill--hidden', isFleet);

        if (isFleet) renderAuditFleet();
        else renderDrillDown();
    }

    // ══════════════════════════════════════════════════════════
    //  SHIFT SELECTOR WIRING
    // ══════════════════════════════════════════════════════════

    function wireShiftButtons() {
        var labels = { '12': 'Rolling 12 Hours', '5': 'Since 05:00 AM (Day)', '15': 'Since 03:00 PM (Night)' };
        var btns = document.querySelectorAll('.shift-btn');
        btns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentShift = parseInt(this.getAttribute('data-shift'));
                btns.forEach(function (b) { b.classList.remove('shift-btn--active'); });
                this.classList.add('shift-btn--active');
                document.getElementById('shiftLabel').textContent = labels[currentShift] || 'Rolling 12 Hours';
                renderLive();
            });
        });
    }

    // ══════════════════════════════════════════════════════════
    //  GEOTAB ADD-IN ENTRY POINT
    // ══════════════════════════════════════════════════════════

    geotab.addin.spotterIQ = function (api, state) {
        return {

            /**
             * initialize: Called once when the Add-in first loads.
             * Resolves leaf group, wires event handlers, renders initial view.
             */
            initialize: function (freshApi, freshState, callback) {
                initTooltip();

                // Resolve leaf group for header branding
                resolveLeafGroup(freshApi, function (leafName) {
                    document.getElementById('leafGroupName').textContent = leafName;
                });

                // Tab switching
                document.getElementById('tabLive').addEventListener('click', function () { switchTab('live'); });
                document.getElementById('tabAudit').addEventListener('click', function () { switchTab('audit'); });

                // Drill-down back button
                document.getElementById('drillBack').addEventListener('click', function () {
                    auditState.view = 'fleet';
                    showAuditView();
                });

                // Shift buttons
                wireShiftButtons();

                // Initial render
                renderLive();

                callback();
            },

            /**
             * focus: Called each time the user navigates to this Add-in.
             * Refreshes the active view.
             */
            focus: function (freshApi, freshState) {
                if (activeTab === 'live') renderLive();
                else showAuditView();
            },

            /**
             * blur: Called when the user navigates away.
             * Clean up intervals or listeners if needed.
             */
            blur: function () {
                // No active intervals to clear in sample mode.
                // When wired to live data, clear any setInterval handles here.
            }
        };
    };

})();
