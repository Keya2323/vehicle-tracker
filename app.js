/* =====================================================================
   app.js  -  Vehicle Tracker dashboard
   No frameworks, no CDN: works offline and inside sandboxed previews.
   Two modes:
     LIVE  : WORKER_URL is set  -> talks to the Cloudflare Worker
             -> Worker talks to ThingsBoard -> ESP32 telemetry
     DEMO  : WORKER_URL is ""   -> simulated car, perfect for UI work
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var DEMO = !CFG.WORKER_URL;
  var POLL_MS = CFG.POLL_MS || 5000;
  var DEVICE = CFG.DEVICE_NAME || "vehicle-01";

  var state = {
    token: null,
    telemetry: null,
    trail: [],           // [{lat,lon}]
    events: [],          // [{t, name}]
    motorOn: true,
    armed: false,
    lastEvent: null,
    sim: { t: 0, lat: 23.8103, lon: 90.4125, battery: 8.15 }
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- api */
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    return fetch(CFG.WORKER_URL.replace(/\/$/, "") + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error("session expired"); }
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
      return r.json();
    });
  }

  /* --------------------------------------------------------- demo model */
  function simStep() {
    var s = state.sim;
    s.t += 1;
    var r = 0.0016;                                   // ~180 m radius loop
    s.lat = 23.8103 + Math.sin(s.t / 12) * r;
    s.lon = 90.4125 + Math.cos(s.t / 12) * r;
    s.battery = Math.max(6.4, s.battery - 0.004);
    var speed = 18 + Math.sin(s.t / 5) * 9 + Math.random() * 3;
    var g = 1 + (Math.random() - 0.5) * 0.12;
    var event = "normal";

    if (s.t === 14) event = "theft";
    if (s.t === 26) { event = "accident"; g = 3.10; speed = 0; }
    if (s.t === 30) event = "sos_cancelled";
    if (s.t === 40) event = "geofence_exit";
    if (s.t > 46) s.t = 0;

    return {
      lat: s.lat, lon: s.lon, speed_kmh: Math.round(speed * 10) / 10,
      battery_v: Math.round(s.battery * 100) / 100,
      g_total: Math.round(g * 100) / 100,
      event: event, _sats: 9, _link: "2G"
    };
  }

  /* -------------------------------------------------------------- login */
  function login() {
    var pass = $("inp-pass").value || "";
    var errBox = $("login-err");
    errBox.hidden = true;
    $("btn-login").disabled = true;

    var done = function (token) {
      state.token = token || "demo";
      try { sessionStorage.setItem("vt-token", state.token); } catch (e) {}
      showApp();
      $("btn-login").disabled = false;
    };

    if (DEMO) { setTimeout(function () { done("demo"); }, 250); return; }

    api("/api/login", { method: "POST", body: { password: pass } })
      .then(function (res) { done(res.token); })
      .catch(function (e) {
        $("btn-login").disabled = false;
        errBox.textContent = "Login failed: " + e.message;
        errBox.hidden = false;
      });
  }

  function logout() {
    state.token = null;
    try { sessionStorage.removeItem("vt-token"); } catch (e) {}
    $("view-app").hidden = true;
    $("view-login").hidden = false;
  }

  function showApp() {
    $("view-login").hidden = true;
    $("view-app").hidden = false;
    $("device-name").textContent = DEVICE;
    $("mode-label").textContent = DEMO ? "demo data" : "live · ThingsBoard";
    $("poll-ms").textContent = Math.round(POLL_MS / 1000);
    $("demo-note").hidden = !DEMO;
    loadSettings();
    wireDrive();
    poll();
    setInterval(poll, POLL_MS);
  }

  /* --------------------------------------------------------------- poll */
  var pollBusy = false;
  function poll() {
    if (pollBusy) return;
    pollBusy = true;

    if (DEMO) {
      applyTelemetry(simStep());
      pollBusy = false;
      return;
    }

    api("/api/telemetry?device=" + encodeURIComponent(DEVICE))
      .then(function (d) { applyTelemetry(normalize(d)); })
      .catch(function (e) { setLink("offline", "bad"); console.warn(e.message); })
      .then(function () { pollBusy = false; });
  }

  /* ThingBoard returns {lat:[{ts,value}], ...} -> flat object */
  function normalize(d) {
    var out = {};
    Object.keys(d || {}).forEach(function (k) {
      var arr = d[k];
      if (Array.isArray(arr) && arr.length) {
        var v = arr[arr.length - 1].value;
        out[k] = isNaN(Number(v)) ? v : Number(v);
      }
    });
    return out;
  }

  /* -------------------------------------------------------------- render */
  function applyTelemetry(t) {
    if (!t) return;
    state.telemetry = t;

    // trail
    if (typeof t.lat === "number" && typeof t.lon === "number") {
      var last = state.trail[state.trail.length - 1];
      if (!last || Math.abs(last.lat - t.lat) > 1e-7 || Math.abs(last.lon - t.lon) > 1e-7) {
        state.trail.push({ lat: t.lat, lon: t.lon });
        if (state.trail.length > 60) state.trail.shift();
      }
      $("map-coords").textContent = t.lat.toFixed(5) + ", " + t.lon.toFixed(5);
      $("link-maps").href = "https://maps.google.com/?q=" + t.lat + "," + t.lon;
    }

    // no coordinates yet -> say so instead of showing an empty grid
    var hasFix = (typeof t.lat === "number" && typeof t.lon === "number" &&
                  !(t.lat === 0 && t.lon === 0));
    if ($("map-hint")) $("map-hint").style.display = hasFix ? "none" : "flex";

    var sats = (t.sats != null ? t.sats : (t._sats != null ? t._sats : null));
    var noFix = (t.fix === 0) || (t.fix == null && !(sats > 0));

    $("v-speed").textContent = fmt(t.speed_kmh, 1);
    if ($("speed-note")) {
      $("speed-note").style.display = noFix ? "block" : "none";
      $("speed-note").textContent = noFix ? "needs GPS fix" : "";
    }
    $("v-g").textContent = fmt(t.g_total, 2);
    $("v-sats").textContent = (sats != null ? sats : "—");
    // 0 satellites = the module is still looking for the sky
    if ($("sats-note")) {
      var searching = !(sats > 0);
      $("sats-note").style.display = searching ? "block" : "none";
      $("sats-note").textContent = searching ? "searching for sky…" : "";
    }
    // Battery card is not shown on this build (no voltage divider fitted).
    // Everything below only runs if the card markup exists in index.html.
    if ($("v-battery")) {
      var hasBat = (typeof t.battery_v === "number" && t.battery_v > 1.0);
      $("v-battery").textContent = hasBat ? fmt(t.battery_v, 2) : "—";
      var pct = hasBat
        ? Math.max(0, Math.min(100, ((t.battery_v - 6.0) / (8.4 - 6.0)) * 100))
        : 0;
      var bar = $("bar-battery");
      if (bar) {
        bar.style.width = pct.toFixed(0) + "%";
        bar.className = pct < 32 ? "low" : "";
      }
    }

    if (t.g_total >= 2.5) document.body.classList.add("impact");
    else document.body.classList.remove("impact");

    setLink(t._link || (DEMO ? "2G" : "live"), "ok");
    $("last-update").textContent = "updated " + new Date().toLocaleTimeString();

    // device reports its real motor state on every telemetry: stay in sync
    if (typeof t.motor === "number") {
      var devOn = (t.motor === 1);
      if (devOn !== state.motorOn) {
        var wasKnown = state.motorKnown;
        setMotorState(devOn);
        if (wasKnown) pushEvent(devOn ? "motor_on" : "motor_cut");
      }
      state.motorKnown = true;
    }

    if (t.event && t.event !== "normal" && t.event !== state.lastEvent) {
      state.lastEvent = t.event;
      pushEvent(t.event);
      if (t.event === "armed") setArmed(true);
      if (t.event === "disarmed") setArmed(false);
      if (t.event === "motor_cut") setMotorState(false);
      if (t.event === "motor_on") setMotorState(true);
      if (t.event === "theft") {
        document.body.classList.add("impact");
        showToast("THEFT ALERT", "Unauthorised movement while the guard is ON", "bad");
      } else if (t.event === "accident") {
        document.body.classList.add("impact");
        showToast("ACCIDENT DETECTED", "Impact over the threshold - check the car", "bad");
      } else if (t.event === "geofence_exit") {
        showToast("GEOFENCE EXIT", "The car left the allowed area", "bad");
      } else if (t.event === "armed") {
        showToast("GUARD ON", "Theft + geofence alerts are now active", "ok");
      } else if (t.event === "disarmed") {
        showToast("GUARD OFF", "Theft + geofence alerts muted", "warn");
      }
    }
    if (t.event === "normal") state.lastEvent = null;

    drawMap();
  }

  function fmt(v, d) {
    return (v == null || isNaN(v)) ? "—" : Number(v).toFixed(d);
  }

  function setLink(text, kind) {
    var el = $("pill-link");
    el.textContent = text.toUpperCase();
    el.className = "pill " + (kind === "ok" ? "pill-ok" : kind === "bad" ? "pill-bad" : "pill-warn");
  }

  // ARM/DISARM only controls the THEFT + GEOFENCE guard.
  // Accident detection (impact) is always active - that is why an alarm can
  // still fire while the guard is off. Labels below say so explicitly.
  function setArmed(on) {
    state.armed = on;
    if (!on) state.demoTheftShown = false;
    var el = $("pill-armed");
    el.textContent = on ? "GUARD ON" : "GUARD OFF";
    el.title = on ? "Theft + geofence guard is ON" : "Theft + geofence guard is OFF";
    el.className = "pill " + (on ? "pill-on" : "pill-off");
    $("btn-arm").textContent = on ? "🔓 Disarm theft guard" : "🔒 Arm theft guard";
    if ($("guard-note")) {
      $("guard-note").textContent = on
        ? "Guard ON: theft + geofence alerts active. Accident detection always active."
        : "Guard OFF: theft + geofence alerts muted. Accident detection is STILL active.";
    }
  }

  /* ---------------------------------------------------------------- map */
  function drawMap() {
    var pts = state.trail;
    var svg = $("map-svg");
    if (!pts.length) return;

    var lat0 = pts[0].lat, lon0 = pts[0].lon;
    var minX = 0, maxX = 0, minY = 0, maxY = 0;
    pts.forEach(function (p) {
      var x = (p.lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180);
      var y = (p.lat - lat0) * 110540;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });

    var pad = 40;
    var w = Math.max(maxX - minX, 40), h = Math.max(maxY - minY, 40);
    var scale = Math.min((320 - pad * 2) / w, (320 - pad * 2) / h);
    scale = Math.min(scale, 600);                     // don't over-zoom

    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    function proj(p) {
      var x = (p.lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180);
      var y = (p.lat - lat0) * 110540;
      return [160 + (x - cx) * scale, 160 - (y - cy) * scale];
    }

    var coords = pts.map(function (p) {
      var q = proj(p);
      return q[0].toFixed(1) + "," + q[1].toFixed(1);
    }).join(" ");
    $("track").setAttribute("points", coords);

    var head = proj(pts[pts.length - 1]);
    ["dot"].forEach(function (id) {
      var el = $(id);
      el.setAttribute("cx", head[0]);
      el.setAttribute("cy", head[1]);
    });

    // geofence circle: radius in metres -> pixels
    var rPix = Math.max(8, Math.min(150, (CFG.GEOFENCE_RADIUS_M || 150) * scale));
    var c = $("geo-circle");
    c.setAttribute("cx", 160);
    c.setAttribute("cy", 160);
    c.setAttribute("r", rPix.toFixed(1));

    if (svg) svg.setAttribute("aria-label",
      "Track of " + pts.length + " points, latest at " + head[0].toFixed(0) + "," + head[1].toFixed(0));
  }

  /* --------------------------------------------------------- alarm toast */
  var toastTimer = null;
  function showToast(title, sub, kind) {
    var el = $("toast");
    if (!el) return;
    el.className = "toast show " + (kind || "warn");
    el.innerHTML = '<b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 9000);
  }

  /* ----------------------------------------------------------- timeline */
  var LABEL = {
    accident: "ACCIDENT", theft: "THEFT", geofence_exit: "GEOFENCE EXIT",
    sos_cancelled: "FALSE ALARM CANCELLED", low_battery: "LOW BATTERY",
    armed: "SYSTEM ARMED", disarmed: "SYSTEM DISARMED", i_am_safe: "I'M SAFE PRESSED",
    motor_cut: "MOTOR CUT OFF", motor_on: "MOTOR ENABLED", home_set: "HOME POINT SET",
    mqtt_test: "TEST", settings_saved: "SETTINGS SAVED",
    wifi_connected: "SWITCHED TO WIFI", wifi_failed: "WIFI FAILED (STAYING 2G)"
  };

  function pushEvent(name) {
    var now = new Date();
    var prev = state.events[0];
    if (prev && prev.name === name && (now - prev.t) < 5000) return;   // no duplicates
    state.events.unshift({ t: now, name: name });
    if (state.events.length > 40) state.events.pop();

    var ul = $("timeline");
    ul.innerHTML = "";
    state.events.forEach(function (ev) {
      var li = document.createElement("li");
      var label = LABEL[ev.name] || ev.name.toUpperCase();
      var cls = ev.name === "accident" ? "b-accident"
              : ev.name === "theft" ? "b-theft"
              : ev.name.indexOf("geofence") === 0 ? "b-geofence"
              : ev.name.indexOf("low_battery") === 0 ? "b-theft" : "b-info";
      li.innerHTML =
        '<span class="t mono">' + ev.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</span>" +
        '<span class="badge ' + cls + '">' + label + "</span>";
      ul.appendChild(li);
    });
    $("event-count").textContent = state.events.length + " events";
  }

  /* ----------------------------------------------------------- controls */
  function sendRpc(method, params) {
    if (DEMO) {
      if (method === "setMotor") pushEvent(params ? "motor_on" : "motor_cut");
      else if (method === "setArmed") pushEvent(params ? "armed" : "disarmed");
      else pushEvent("i_am_safe");
      return Promise.resolve({ ok: true });
    }
    return api("/api/rpc", {
      method: "POST",
      body: { device: DEVICE, method: method, params: params }
    }).then(function (r) {
      if (r && r.ok === false) note("Device did not answer - check the 2G/WiFi link.", true);
      return r;
    }).catch(function (e) {
      alert("Command failed: " + e.message);
    });
  }

  function setMotorState(on) {
    state.motorOn = on;
    var b = $("btn-motor");
    b.textContent = on ? "⛔ Cut motor" : "▶ Enable motor";
    b.className = "btn " + (on ? "btn-danger" : "btn-ghost");
  }

  function toggleMotor() {
    var next = !state.motorOn;
    setMotorState(next);
    if (!next) {                          // "Cut motor" = stop + silence, always
      document.body.classList.remove("impact");
      var t = $("toast"); if (t) t.className = "toast";
      showToast("MOTOR CUT OFF", "Alarm silenced - press Enable motor to drive again", "warn");
      sendRpc("setMotor", false);
      sendRpc("sosReset", true);          // the same press clears a running alarm
    } else {                              // "Enable motor" never silences silently
      showToast("MOTOR ENABLED", "The car can be driven again", "ok");
      sendRpc("setMotor", true);
    }
  }

  function toggleArm() {
    var next = !state.armed;
    setArmed(next);
    sendRpc("setArmed", next);        // real arm/disarm RPC in the firmware
  }

  /* Drive D-pad: press-and-hold -> repeat every 1.5 s (firmware stops after 4 s) */
  var driveTimer = null, driveDir = "S";

  function driveSend(dir) {
    // Only "Cut motor" stops driving. A running alarm is just a warning.
    if (dir !== "S" && !state.motorOn) {
      showToast("DRIVE BLOCKED", "Motor is cut - press Enable motor", "bad");
      return;
    }
    sendRpc("drive", dir);
    // DEMO only: reproduce the firmware rule "driving while armed = theft"
    if (DEMO && state.armed && dir !== "S" && !state.demoTheftShown) {
      state.demoTheftShown = true;
      setTimeout(function () {
        if (!state.armed) return;
        pushEvent("theft");
        document.body.classList.add("impact");
        showToast("THEFT ALERT", "Unauthorised movement while the guard is ON", "bad");
      }, 1500);
    }
  }

  function driveStart(dir) {
    driveDir = dir;
    driveSend(dir);
    if (driveTimer) clearInterval(driveTimer);
    if (dir !== "S") driveTimer = setInterval(function () { driveSend(dir); }, 1500);
  }

  function driveStop() {
    if (driveTimer) { clearInterval(driveTimer); driveTimer = null; }
    if (driveDir !== "S") { driveDir = "S"; driveSend("S"); }
  }

  function wireDrive() {
    var btns = document.querySelectorAll(".drive");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        var dir = b.getAttribute("data-dir");
        if (dir === "S") {
          b.addEventListener("click", function () { driveStart("S"); });
          return;
        }
        b.addEventListener("pointerdown", function (e) { e.preventDefault(); driveStart(dir); });
        b.addEventListener("pointerup", function () { driveStop(); });
        b.addEventListener("pointerleave", function () { driveStop(); });
        b.addEventListener("pointercancel", function () { driveStop(); });
      })(btns[i]);
    }
  }

  function resetAlarm() {
    document.body.classList.remove("impact");
    state.demoTheftShown = false;
    var t = $("toast"); if (t) t.className = "toast";
    pushEvent("i_am_safe");
    sendRpc("sosReset", true);
  }

  /* ----------------------------------------------------------- settings */
  function settingsToForm(obj) {
    $("set-ssid").value = obj.wifi_ssid || "";
    $("set-pass").value = obj.wifi_pass || "";
    $("set-phone").value  = obj.alert_phone || obj.owner_phone || "";
    $("set-phone2").value = obj.owner_phone && obj.owner_phone !== obj.alert_phone
                            ? obj.owner_phone : "";
    var hla = parseFloat(obj.home_lat), hlo = parseFloat(obj.home_lon);
    $("set-home-lat").value = isNaN(hla) ? "" : hla.toFixed(6);
    $("set-home-lon").value = isNaN(hlo) ? "" : hlo.toFixed(6);
  }

  function loadSettings() {
    if (DEMO) {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem("vt-settings") || "{}"); } catch (e) {}
      settingsToForm(saved);
      return;
    }
    api("/api/attributes?device=" + encodeURIComponent(DEVICE))
      .then(function (list) {
        var obj = {};
        (list || []).forEach(function (a) { if (a && a.key) obj[a.key] = a.value; });
        settingsToForm(obj);
      })
      .catch(function (e) { note("Could not load settings: " + e.message, true); });
  }

  /* Fill the geofence fields with the phone's own GPS position */
  function useMyLocation() {
    if (!navigator.geolocation) {
      note("This browser has no geolocation - type the lat/lon from Google Maps.", true); return;
    }
    note("Reading your position…");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        $("set-home-lat").value = pos.coords.latitude.toFixed(6);
        $("set-home-lon").value = pos.coords.longitude.toFixed(6);
        note("Position filled in - now press Save to device. (Accuracy " +
             Math.round(pos.coords.accuracy) + " m)");
      },
      function (err) {
        note("Location blocked (" + err.message + "). Open the app over https:// " +
             "(GitHub Pages) or type lat/lon from Google Maps.", true);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function note(msg, isErr) {
    var n = $("settings-note");
    n.textContent = msg;
    n.style.color = isErr ? "var(--bad)" : "var(--muted)";
  }

  function saveSettings() {
    var ssid   = $("set-ssid").value.trim();
    var pass   = $("set-pass").value;
    var phone  = $("set-phone").value.trim();
    var phone2 = $("set-phone2").value.trim();

    var hlat = parseFloat($("set-home-lat").value);
    var hlon = parseFloat($("set-home-lon").value);
    var hasLat = !isNaN(hlat) && hlat > -90  && hlat < 90  && hlat !== 0;
    var hasLon = !isNaN(hlon) && hlon > -180 && hlon < 180 && hlon !== 0;
    if (hasLat !== hasLon) {
      note("Fill BOTH home latitude and longitude (or leave both blank).", true); return;
    }

    if (!ssid && !phone && !phone2 && !hasLat) {
      note("Enter a WiFi name, a phone number or a home point first.", true); return;
    }
    if (phone && phone.replace(/[^0-9]/g, "").length < 10) {
      note("Emergency phone looks too short - use +8801XXXXXXXXX.", true); return;
    }
    if (phone2 && phone2.replace(/[^0-9]/g, "").length < 10) {
      note("Command phone looks too short - use +8801XXXXXXXXX.", true); return;
    }

    var attrs = {};
    if (ssid) attrs.wifi_ssid = ssid;
    // never send an empty password - it would wipe the one saved on the car
    if (ssid && pass) attrs.wifi_pass = pass;
    function e164(n) {                          // 01712... -> +8801712...
      if (!n) return "";
      var d = n.replace(/[^0-9]/g, "");
      if (n.trim().charAt(0) === "+") return "+" + (d.indexOf("880") === 0 ? d : d);
      if (d.length === 11 && d.charAt(0) === "0") return "+88" + d;
      if (d.length === 10 && d.charAt(0) === "1") return "+880" + d;
      return "+" + d;
    }
    var alertNo = e164(phone || phone2);        // at least one number is set
    var ownerNo = e164(phone2 || phone);        // blank command phone = same as alert
    if (alertNo) attrs.alert_phone = alertNo;
    if (ownerNo) attrs.owner_phone = ownerNo;
    if (hasLat && hasLon) { attrs.home_lat = hlat; attrs.home_lon = hlon; }

    $("btn-save-settings").disabled = true;
    note("Saving…");

    if (DEMO) {
      try {
        var old = JSON.parse(localStorage.getItem("vt-settings") || "{}");
        Object.keys(attrs).forEach(function (k) { old[k] = attrs[k]; });
        localStorage.setItem("vt-settings", JSON.stringify(old));
      } catch (e) {}
      setTimeout(function () {
        $("btn-save-settings").disabled = false;
        note("Saved (demo). In live mode this reaches the car over 2G within ~30 s.");
        pushEvent("settings_saved");
      }, 400);
      return;
    }

    api("/api/attributes", {
      method: "POST",
      body: { device: DEVICE, attributes: attrs }
    })
      .then(function () {
        $("btn-save-settings").disabled = false;
        $("set-pass").value = "";                  // don't keep the password on screen
        note("Saved ✓ Sent over 2G. The device will apply it and switch to WiFi within ~30 s.");
        pushEvent("settings_saved");
      })
      .catch(function (e) {
        $("btn-save-settings").disabled = false;
        note("Save failed: " + e.message, true);
      });
  }

  /* --------------------------------------------------------------- init */
  function init() {
    $("btn-login").addEventListener("click", function (e) { e.preventDefault(); login(); });
    $("inp-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
    $("btn-logout").addEventListener("click", logout);
    $("btn-motor").addEventListener("click", toggleMotor);
    $("btn-arm").addEventListener("click", toggleArm);
    $("btn-reset").addEventListener("click", resetAlarm);
    $("btn-save-settings").addEventListener("click", saveSettings);
    $("btn-my-loc").addEventListener("click", useMyLocation);
    $("demo-note").hidden = !DEMO;
    $("inp-pass").focus();

    try {
      var saved = sessionStorage.getItem("vt-token");
      if (saved) { state.token = saved; showApp(); }
    } catch (e) {}

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
