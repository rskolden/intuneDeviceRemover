import axios from "axios";
import csvparser from "csv-parser";
import * as fs from "fs";
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import xlsx from "xlsx";
import electronLog from "electron-log";

import pkg from "electron-updater";
const { autoUpdater } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = getTempDirectory();

// Logging (optional)
autoUpdater.logger = electronLog;
autoUpdater.logger.transports.file.level = "info";

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => (mainWindow = null));
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  // Trigger check after window is ready
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 2000);
});

// Events
autoUpdater.on("error", (err) => {
  console.error("Update error:", err == null ? "unknown" : (err.stack || err).toString());
});

autoUpdater.on("update-available", (info) => {
  console.log("Update available:", info.version);
  mainWindow?.webContents?.send("update-available", info);
});

autoUpdater.on("update-not-available", () => {
  console.log("No updates available");
});

autoUpdater.on("download-progress", (progress) => {
  console.log(`Download speed: ${progress.bytesPerSecond}`);
  console.log(`Downloaded ${progress.percent.toFixed(2)}%`);
});

autoUpdater.on("update-downloaded", (info) => {
  console.log("Update downloaded:", info.version);

  // Ask the user if they want to install
  dialog
    .showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      message: "A new version has been downloaded. Restart now?",
    })
    .then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
});

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow) createWindow();
});

// …imports, __dirname, tempDir, createWindow, app lifecycle remain the same…

ipcMain.handle("exit-app", () => {
  try {
    console.log("Removing temp directory:", tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove temp directory: ${err.message}`);
  }
  app.quit();
});

// ================= CSV Loader =================
ipcMain.handle("load-csv-serialnumbers", async (event, columnInput) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "CSV or Excel Files", extensions: ["csv", "xlsx"] }],
  });

  if (result.canceled || !result.filePaths?.[0]) return { data: [] };
  const filePath = result.filePaths[0];
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  try {
    let data = [];
    if (ext === ".csv") {
      data = await new Promise((resolve, reject) => {
        const results = [];
        let serialHeader = null;

        const stream = fs
          .createReadStream(filePath)
          .pipe(csvparser())
          .on("headers", (headers) => {
            const idx = headers.findIndex((h) => h === columnInput);
            if (idx === -1) {
              reject(new Error("CSV file must contain a 'Serial From Diagnostic' column."));
              stream.destroy();
              return;
            }
            serialHeader = headers[idx];
          })
          .on("data", (row) => {
            if (serialHeader && row[serialHeader]) results.push(row[serialHeader].trim());
          })
          .on("end", () => resolve(results))
          .on("error", reject);
      });
    } else if (ext === ".xlsx") {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

      console.log(rows[0]);

      // Find the serialnumber column (case-insensitive)
      const serialCol = Object.keys(rows[0] || {}).find((k) => k === columnInput);
      if (!serialCol) throw new Error("Excel file must contain a 'Serial From Diagnostic' column.");

      data = rows
        .map((row) => row[serialCol])
        .filter((val) => !!val)
        .map((val) => String(val).trim());
    } else {
      throw new Error("Unsupported file type. Please select a CSV or XLSX file.");
    }

    mainWindow?.webContents?.send("clear-alerts");
    return { filePath, filename, data };
  } catch (err) {
    alertHandler(`Error loading serialnumber data: ${err}`);
    throw err;
  }
});

// ================= SERIAL PROCESSING =================
ipcMain.handle("process-serials", async (event, { serialNumbers, connectInfo, dryRun }) => {
  let token;
  try {
    token = await getAccessToken(connectInfo.tenant, connectInfo.clientId, connectInfo.clientSecret);
  } catch (err) {
    return { error: "Failed to get access token" };
  }

  const tasks = serialNumbers.map((serial) => async () => removeDevice(serial, token, dryRun));
  const results = await throttlePromises(tasks, 5);

  const flatResults = results.flat().filter(Boolean);

  // --- Export data to single CSV ---
  const filePath = exportData(dryRun ? "dryRun_results" : "results", flatResults);

  log("Finished processing all devices.");
  return { filePath }; // single path, not array
});

// ================= REMOVE DEVICE =================
async function removeDevice(serial, token, dryRun = false) {
  const headers = { Authorization: `Bearer ${token}` };

  const results = [];

  // Generic deletion helper
  async function processDevices(url, typeName, extraSelect = "") {
    try {
      const query = `$filter=contains(serialNumber,'${serial}')${extraSelect ? `&$select=${extraSelect}` : ""}`;
      const response = await axios.get(`${url}?${query}`, { headers });
      const devices = response.data.value || [];

      if (!devices.length) {
        results.push({ serial, id: "", operatingSystem: "", type: typeName, status: "Missing" });
        log(`Missing: ${typeName} device with serial ${serial}`);
      }

      for (const device of devices) {
        const row = {
          serial,
          id: device.id,
          operatingSystem: device.operatingSystem || "",
          type: typeName,
          status: "",
        };

        if (dryRun) {
          row.status = "Dry Run";
          log(`Dry run: Would delete ${typeName} device ${device.id} (${serial})`);
          results.push(row);
          continue;
        }

        try {
          log(`Deleting ${typeName} device ${device.id} (${serial})`);
          await axios.delete(`${url}/${device.id}`, { headers });
          row.status = "Success";
        } catch (err) {
          row.status = "Failure";
          row.error = err.message;
        }
        results.push(row);
      }

      return devices;
    } catch (err) {
      results.push({ serial, id: "", operatingSystem: "", type: typeName, status: "Error", error: err.message });
      log(`${typeName} error for serial ${serial}: ${err.message}`);
      return [];
    }
  }

  // --- Always start with Intune managed devices ---
  const managedDevices = await processDevices("https://graph.microsoft.com/beta/deviceManagement/managedDevices", "Intune", "id,operatingSystem");

  // --- Only process Autopilot if Windows ---
  const hasWindows = managedDevices.some((d) => d.operatingSystem?.toLowerCase() === "windows");
  if (hasWindows) {
    await processDevices("https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeviceIdentities", "Autopilot");
  } else {
    log(`Skipping Autopilot for serial ${serial}, not a Windows device`);
  }

  return results;
}

// ================= IPC HANDLERS =================
ipcMain.handle("fetch-token", async (event, connectInfo) => {
  try {
    const token = await getAccessToken(connectInfo.tenant, connectInfo.clientId, connectInfo.clientSecret);
    log("Access token fetched successfully.");
    return token;
  } catch (err) {
    alertHandler(`Error fetching access token: ${err.message}`);
    return { error: err.message };
  }
});

// ================= HELPERS =================
ipcMain.handle("load-connection-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { data: [] };
  const filePath = result.filePaths[0];
  const filename = path.basename(filePath);
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const jsonData = JSON.parse(fileContent);
    if (jsonData.tenant && jsonData.clientId && jsonData.clientSecret) {
      mainWindow?.webContents?.send("clear-alerts");
      return { filePath, filename, jsonData };
    } else {
      throw new Error("JSON file must contain tenant, clientId, and clientSecret fields.");
    }
  } catch (err) {
    alertHandler(`Error loading connection data: ${err}`);
    return { error: err.message };
  }
});

async function throttlePromises(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then((res) => res);
    results.push(p);
    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    if (executing.length >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return Promise.all(results);
}

async function getAccessToken(tenantId, clientId, clientSecret) {
  const authority = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "https://graph.microsoft.com/.default");

  const response = await axios.post(authority, params);
  return response.data.access_token;
}

function getTempDirectory() {
  // Get the OS's temp directory and append your custom subdirectory
  const tempDir = path.join(os.tmpdir(), "intune-autopilot-remover");

  // Ensure the temp directory exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  console.log(`Using temp directory: ${tempDir}`);
  return tempDir;
}

function log(msg) {
  console.log(msg);
  mainWindow?.webContents?.send("logging", msg);
}

function alertHandler(msg) {
  console.error(msg);
  mainWindow?.webContents?.send("alert", msg);
}

// ================= JSON & ZIP =================
function exportData(title, data) {
  console.log(`Exporting data for ${title}`);
  console.log(data);
  if (!data || !Array.isArray(data)) throw new Error(`No array data provided for "${title}"`);
  if (data.length === 0) throw new Error(`No data to export for "${title}"`);
  const filePath = path.join(tempDir, `${title}.csv`);
  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(","),
    ...data.map((row) =>
      headers
        .map((h) => {
          const val = row[h] ?? "";
          // Escape double quotes and wrap in quotes if needed
          const safe = String(val).replace(/"/g, '""');
          return /[",\n]/.test(safe) ? `"${safe}"` : safe;
        })
        .join(",")
    ),
  ];
  fs.writeFileSync(filePath, csvRows.join("\n"));
  console.log(`Data saved to ${filePath}`);
  return filePath;
}

ipcMain.handle("exportData", (event, { title, data }) => exportData(title, data));

ipcMain.handle("move-exported-files", async (event, exportedFile) => {
  const now = new Date();
  const yyyyMMdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const newFileName = `autopilotRemoval_${yyyyMMdd}.csv`;

  try {
    const { filePath } = await dialog.showSaveDialog({
      title: "Save CSV file",
      defaultPath: newFileName,
      filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });

    if (!filePath) return { canceled: true };

    fs.copyFileSync(exportedFile, filePath);
    return { canceled: false, filePath };
  } catch (err) {
    console.error(err);
    throw err;
  }
});
