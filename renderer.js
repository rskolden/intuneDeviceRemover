// === ELEMENT SELECTORS ===
const el = (id) => document.getElementById(id);
const logContainer = el("logContainer");

const elements = {
  loadedFile: el("loadedFile"),
  loadedConnectionFile: el("loadedConnectionFile"),
  currentVersion: el("currentVersion"),
  updateSection: el("updateSection"),
  progress: el("updateProgress"),
  progressBar: el("updateProgressBar"),
  columnInput: el("columnInput"),
};

const buttons = {
  csv: el("csvButton"),
  connectionFile: el("connectionFile"),
  checkToken: el("checkTokenButton"),
  checkAppSecret: el("checkAppSecretButton"),
  update: el("updateButton"),
  run: el("runButton"),
  dryRun: el("dryRunButton"),
  export: el("exportButton"),
  exit: el("exitButton"),
};

// === STATE ===
let serialNumbers = [];
let exportedFile = null;
let currentVersion = "";
let connectInfo = {}; // ← store connection info from JSON file

// === HELPERS ===
const logHandler = (msg, type = "log") => {
  const div = document.createElement("div");
  div.textContent = msg;
  if (type === "alert") div.className = "alert alert-danger";
  logContainer.appendChild(div);
  logContainer.scrollTop = logContainer.scrollHeight;
};

const alertHandler = (msg) => logHandler(msg, "alert");
const clearAlerts = () => [...logContainer.querySelectorAll(".alert")].forEach((a) => a.remove());

const toggleButtons = (enabled, list = []) => {
  list.forEach((name) => {
    if (buttons[name]) buttons[name].disabled = !enabled;
  });
};

// === MAIN FUNCTIONS ===
async function loadCsv() {
  const columnName = elements.columnInput?.value.trim();
  if (!columnName) return alertHandler("Please enter a column name.");

  const { filename, data } = await electron.invoke("load-csv-serialnumbers", columnName);
  elements.loadedFile.textContent = filename || "No file loaded";

  if (!data?.length) return logHandler("No serial numbers found.");
  serialNumbers = data.filter(Boolean);
  console.log("Loaded serial numbers:", serialNumbers);
  logHandler(`✅ Loaded ${serialNumbers.length} serial numbers.`);
  toggleButtons(true, ["dryRun", "run"]);
}

async function loadConnectionFile() {
  try {
    const { filename, jsonData } = await electron.invoke("load-connection-file");
    elements.loadedConnectionFile.textContent = filename || "No file loaded";

    if (jsonData) {
      connectInfo = {
        tenant_name_or_id: jsonData.tenant_name_or_id || "",
        client_id: jsonData.client_id || "",
        client_secret: jsonData.client_secret || "",
        client_secret_id: jsonData.client_secret_id || "",
        object_id: jsonData.object_id || "",
      };

      logHandler("✅ Connection info loaded from file.");
      console.log("Connection Info:", connectInfo);
      toggleButtons(true, ["checkToken", "checkAppSecret"]);
    } else {
      logHandler("No connection info found in file.");
    }
  } catch (e) {
    alertHandler(`Error loading connection file: ${e.message}`);
  }
}

async function processSerial(dryRun = false) {
  if (!serialNumbers.length) return alertHandler("No serial numbers loaded.");
  if (!connectInfo.tenant_name_or_id || !connectInfo.client_id || !connectInfo.client_secret)
    return alertHandler("Connection info missing. Load connection file first.");

  logHandler("------------------------------");
  logHandler(dryRun ? "Starting dry run..." : "Starting processing...");

  toggleButtons(false, ["dryRun", "run", "csv", "checkToken"]);

  try {
    // Now we store data instead of a file
    const res = await electron.invoke("process-serials", { serialNumbers, connectInfo, dryRun });
    if (res.error) {
      alertHandler(`Error: ${res.error}`);
    } else {
      exportedFile = res.data; // <-- store results as array
      logHandler(`✅ Processed ${exportedFile.length} devices.`);
      toggleButtons(true, ["export"]);
      logHandler("Processing completed.");
    }
  } catch (err) {
    alertHandler(`Processing failed: ${err.message}`);
  } finally {
    toggleButtons(true, ["dryRun", "run", "csv", "checkToken"]);
  }
}
// === VERSION & UPDATE ===
async function checkCurrentVersion() {
  currentVersion = await electron.invoke("get-app-version");
  elements.currentVersion.textContent = currentVersion;
}

async function checkForUpdates() {
  const latest = await electron.invoke("get-latest-update");
  if (!latest?.version) return;
  if (isNewerVersion(currentVersion, latest.version)) {
    elements.updateSection.classList.remove("d-none");
    buttons.update.textContent = `Update available: ${latest.version}`;
  } else {
    console.log("✅ Already up-to-date:", currentVersion);
  }
}

function isNewerVersion(curr, next) {
  const a = curr.split(".").map(Number);
  const b = next.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

// === BUTTON HANDLERS ===
buttons.csv.addEventListener("click", loadCsv);
buttons.connectionFile.addEventListener("click", loadConnectionFile);
buttons.run.addEventListener("click", () => processSerial(false));
buttons.dryRun.addEventListener("click", () => processSerial(true));
buttons.exit.addEventListener("click", () => electron.invoke("exit-app"));

buttons.export.addEventListener("click", async () => {
  if (!exportedFile || !exportedFile.length) return alertHandler("No results to export.");

  try {
    const now = new Date();
    const yyyyMMddHHmm = now.toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 12);

    const defaultFileName = `results_${yyyyMMddHHmm}.csv`;

    const { filePath, canceled } = await electron.invoke("save-exported-file", {
      defaultFileName,
      data: exportedFile,
    });

    if (!canceled) {
      logHandler(`✅ Exported to: ${filePath}`);
    } else {
      logHandler("Export canceled.");
    }
  } catch (e) {
    alertHandler(`Export failed: ${e.message}`);
  }
});

buttons.checkToken.addEventListener("click", async () => {
  if (!connectInfo.tenant_name_or_id || !connectInfo.client_id || !connectInfo.client_secret) {
    return alertHandler("Tenant ID, App ID, and App Secret are required.");
  }

  try {
    // Send the entire object
    const token = await electron.invoke("fetch-token", connectInfo);
    console.log("Access token:", token);
    logHandler("✅ Token fetched successfully.");
  } catch (err) {
    alertHandler(`Failed to fetch token: ${err.message}`);
  }
});

buttons.checkAppSecret.addEventListener("click", async () => {
  const missing = Object.entries(connectInfo)
    .filter(([_, v]) => !v)
    .map(([k]) => k.replace(/_/g, " "));
  if (missing.length) return alertHandler(`Missing required fields: ${missing.join(", ")}`);
  const appSecret = await electron.invoke("check-app-secret", connectInfo);
  if (appSecret.error) {
    alertHandler(`Error: ${appSecret.error}`);
  } else {
    console.log("App Secret valid. Days until expiration:", appSecret);
    logHandler(`✅ App Secret valid. Days until expiration: ${appSecret}`);
  }
});

elements.columnInput.addEventListener("input", () => {
  buttons.csv.disabled = !elements.columnInput.value.trim();
});

// === MESSAGE LISTENERS ===
electron.receive("logging", logHandler);
electron.receive("alert", alertHandler);
electron.receive("clear-alerts", clearAlerts);

// === INIT ===
checkCurrentVersion();
checkForUpdates();
