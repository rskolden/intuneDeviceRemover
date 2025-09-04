const loadedFile = document.getElementById("loadedFile");
const logContainer = document.getElementById("logContainer");
const loadedConnectionFile = document.getElementById("loadedConnectionFile");
let tenantEl = document.getElementById("tenantInput");
let clientidEl = document.getElementById("clientIdInput");
let clientsecretEl = document.getElementById("clientSecretInput");

let serialNumbers = [];
let exportedFile = null; // single file path

const buttons = {
  csv: document.getElementById("csvButton"),
  connectionFile: document.getElementById("connectionFile"),
  fetchToken: document.getElementById("fetchTokenButton"),
  run: document.getElementById("runButton"),
  dryRun: document.getElementById("dryRunButton"),
  export: document.getElementById("exportButton"),
  exit: document.getElementById("exitButton"),
};

function toggleButtons(state, buttonNames = []) {
  buttonNames.forEach((button) => {
    if (buttons[button]) buttons[button].disabled = !state;
    else console.error(`Button '${button}' not found.`);
  });
}

const logHandler = (message) => {
  const line = document.createElement("div");
  line.textContent = message;
  logContainer.appendChild(line);
  logContainer.scrollTop = logContainer.scrollHeight;
};

const alertHandler = (message) => {
  const alertBox = document.createElement("div");
  alertBox.className = "alert alert-danger";
  alertBox.textContent = message;
  logContainer.appendChild(alertBox);
  logContainer.scrollTop = logContainer.scrollHeight;
};

const clearAlerts = () => {
  const alerts = logContainer.querySelectorAll(".alert");
  alerts.forEach((alert) => alert.remove());
};

async function loadCsv() {
  const columnInput = document.getElementById("columnInput");
  const columnName = columnInput ? columnInput.value.trim() : "";

  if (!columnName) {
    alertHandler("Please enter a column name to load serial numbers from.");
    return;
  }

  const { filePath, filename, data } = await electron.invoke("load-csv-serialnumbers", columnName);
  loadedFile.textContent = filename || "No file loaded";
  if (!data || !data.length) {
    logHandler("No serial numbers found in the CSV file.");
    return;
  }

  serialNumbers = data.filter(Boolean);
  logHandler(`Loaded ${serialNumbers.length} serial numbers from CSV file.`);
  console.log("Serial Numbers:", serialNumbers);
  toggleButtons(true, ["dryRun", "run"]);
}

async function loadConnectionFile() {
  try {
    const { filePath, filename, jsonData } = await electron.invoke("load-connection-file");
    loadedConnectionFile.textContent = filename || "No file loaded";
    if (jsonData) {
      tenantEl.value = jsonData.tenant || "";
      clientidEl.value = jsonData.clientId || "";
      clientsecretEl.value = jsonData.clientSecret || "";
      logHandler("Connection info loaded from file.");
    } else {
      logHandler("No connection info found in the file.");
    }
  } catch (error) {
    alertHandler(`Error loading connection file: ${error}`);
  }
}

async function processSerial(dryRun = false) {
  tenantEl = document.getElementById("tenantInput");
  clientidEl = document.getElementById("clientIdInput");
  clientsecretEl = document.getElementById("clientSecretInput");

  const connectInfo = {
    tenant: tenantEl.value.trim(),
    clientId: clientidEl.value.trim(),
    clientSecret: clientsecretEl.value.trim(),
  };

  logHandler("------------------------------");
  logHandler(dryRun ? "Starting dry run..." : "Starting serial processing...");

  toggleButtons(false, ["dryRun", "run", "csv", "fetchToken"]);

  try {
    const response = await electron.invoke("process-serials", { serialNumbers, connectInfo, dryRun });

    if (response.error) {
      alertHandler(`Error: ${response.error}`);
    } else {
      exportedFile = response.filePath; // single path instead of array
      logHandler(`Results written to CSV: ${response.filePath}`);
      toggleButtons(true, ["export"]);
      logHandler("Processing completed.");
    }
  } catch (err) {
    alertHandler(`Processing failed: ${err.message}`);
  } finally {
    toggleButtons(true, ["dryRun", "run", "csv", "fetchToken"]);
  }
}

// async function exportData(title, data) {
//   if (!title || !data) {
//     console.error("Missing title or data for exportData");
//     return;
//   }
//   const filePath = await electron.invoke("exportData", { title, data });
//   exportedFiles.push(filePath);
// }

buttons.fetchToken.addEventListener("click", async () => {
  tenantEl = document.getElementById("tenantInput");
  clientidEl = document.getElementById("clientIdInput");
  clientsecretEl = document.getElementById("clientSecretInput");

  const connectInfo = {
    tenant: tenantEl.value.trim(),
    clientId: clientidEl.value.trim(),
    clientSecret: clientsecretEl.value.trim(),
  };

  console.log("Fetching token with connectInfo:", connectInfo);
  await electron.invoke("fetch-token", connectInfo);
});

buttons.csv.addEventListener("click", loadCsv);
buttons.connectionFile.addEventListener("click", async () => loadConnectionFile());
buttons.run.addEventListener("click", () => processSerial(false));
buttons.dryRun.addEventListener("click", () => processSerial(true));
buttons.exit.addEventListener("click", () => electron.invoke("exit-app"));

buttons.export.addEventListener("click", async () => {
  try {
    const result = await electron.invoke("move-exported-files", exportedFile);
    if (result.canceled) logHandler("Export file canceled.");
    else logHandler(`Export file saved to: ${result.filePath}`);
  } catch (err) {
    alertHandler(`Failed to save export file: ${err.message}`);
  }
});

// Listen to backend messages
electron.receive("logging", logHandler);
electron.receive("alert", alertHandler);
electron.receive("clear-alerts", clearAlerts);
