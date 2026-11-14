/* =====================================================================
   config.js  -  the only file you edit before deploying
   (this is the equivalent of "replace firebaseConfig" in the video)
   ===================================================================== */

window.APP_CONFIG = {
  /* Cloudflare Worker URL from the deploy step.
     Leave it EMPTY ("") to run in DEMO mode with simulated data. */
  WORKER_URL: "https://vehicle-tracker-bridge.israt-keya1130.workers.dev",

  /* Device name exactly as created in ThingsBoard */
  DEVICE_NAME: "vehicle-01",

  /* Dashboard refresh interval (ms). Keep >= 5000 to save data points. */
  POLL_MS: 5000,

  /* Geofence circle drawn on the map (metres) - keep same as firmware */
  GEOFENCE_RADIUS_M: 150
};
