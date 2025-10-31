// core.js
import electron from "electron";
const { dialog } = electron;
import axios from "axios";
import csvparser from "csv-parser";
import * as fs from "fs";
import xlsx from "xlsx";
import os from "os";
import path from "path";

const latestUpdateUrl = "https://uem.atea.com/intuneDeviceRemover/latest.json";
const tempDir = path.join(os.tmpdir(), "intune-autopilot-remover");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

export async function fetchToken(tenant_name_or_id, client_id, client_secret) {
  const res = await axios.post(
    `https://login.microsoftonline.com/${tenant_name_or_id}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client_id,
      client_secret: client_secret,
      scope: "https://graph.microsoft.com/.default",
    })
  );
  return res.data.access_token;
}

export async function loadSerialNumbers(filePath, columnName) {
  const ext = path.extname(filePath).toLowerCase();
  let data = [];

  if (ext === ".csv") {
    data = await new Promise((resolve, reject) => {
      const results = [];
      fs.createReadStream(filePath)
        .pipe(csvparser())
        .on("headers", (headers) => {
          if (!headers.includes(columnName)) reject(new Error(`Missing column "${columnName}"`));
        })
        .on("data", (row) => row[columnName] && results.push(row[columnName].trim()))
        .on("end", () => resolve(results))
        .on("error", reject);
    });
  } else if (ext === ".xlsx") {
    const wb = xlsx.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows[0]?.[columnName]) throw new Error(`Missing column "${columnName}"`);
    data = rows.map((r) => r[columnName]).filter(Boolean);
  } else {
    throw new Error("Unsupported file type");
  }

  return data;
}

export async function removeDevice(serial, token, dryRun = false, log = console.log) {
  const headers = { Authorization: `Bearer ${token}` };
  const results = [];

  async function processDevices(url, typeName) {
    try {
      const query = `$filter=contains(serialNumber,'${serial}')&$select=id,operatingSystem`;
      const res = await axios.get(`${url}?${query}`, { headers });
      const devices = res.data.value || [];

      // If no devices found, mark as Missing
      if (!devices.length) {
        results.push({ serial, id: "", type: typeName, status: "Missing", error: "" });
        return;
      }

      for (const d of devices) {
        const row = { serial, id: d.id, type: typeName, status: "", error: "" };

        if (dryRun) {
          row.status = "Dry Run";
          log(`Would delete ${typeName} device ${d.id}`);
        } else {
          try {
            await axios.delete(`${url}/${d.id}`, { headers });
            row.status = "Success";
          } catch (err) {
            row.status = "Failure";
            row.error = err.response?.data?.error_description || err.message;
          }
        }

        results.push(row);
      }
    } catch (err) {
      results.push({ serial, id: "", type: typeName, status: "Error", error: err.message });
    }
  }

  await processDevices("https://graph.microsoft.com/beta/deviceManagement/managedDevices", "Intune");
  await processDevices("https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeviceIdentities", "Autopilot");

  return results;
}

export async function processSerials(serials, connectInfo, dryRun = false, log = console.log) {
  const { tenant_name_or_id, client_id, client_secret } = connectInfo;
  const token = await fetchToken(tenant_name_or_id, client_id, client_secret);
  const all = [];

  for (const serial of serials) {
    const res = await removeDevice(serial, token, dryRun, log);
    all.push(...res);
  }

  return { data: all }; // <-- return the array instead of writing a CSV
}

export function exportData(filePath, data) {
  const headers = Object.keys(data[0] || {});
  const csv = [headers.join(","), ...data.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");

  fs.writeFileSync(filePath, csv);
  return filePath;
}

export async function checkAppSecret(connectInfo) {
  const { tenant_name_or_id, client_id, client_secret, object_id, client_secret_id } = connectInfo;
  const token = await fetchToken(tenant_name_or_id, client_id, client_secret);

  try {
    const headers = { Authorization: `Bearer ${token}` };
    const res = await axios.get(`https://graph.microsoft.com/beta/applications/${object_id}`, { headers });

    const appSecret = res.data.passwordCredentials.find((cred) => cred.keyId === client_secret_id);
    if (!appSecret) throw new Error("No matching App Secret found");

    const daysLeft = Math.ceil((new Date(appSecret.endDateTime) - new Date()) / (1000 * 60 * 60 * 24));
    return daysLeft;
  } catch (err) {
    return { error: err.message };
  }
}

export async function loadConnectionFile() {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePaths?.[0]) return { data: [] };

  const filePath = result.filePaths[0];
  const filename = path.basename(filePath);

  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const jsonData = JSON.parse(fileContent);

    // Validate required fields
    const requiredFields = ["tenant_name_or_id", "client_id", "client_secret"];
    const missing = requiredFields.filter((f) => !jsonData[f]);
    if (missing.length) throw new Error(`Missing fields in JSON: ${missing.join(", ")}`);

    return { filePath, filename, jsonData };
  } catch (err) {
    return { error: err.message };
  }
}

export async function getLatestUpdate() {
  try {
    const res = await axios.get(latestUpdateUrl);
    return res.data;
  } catch (err) {
    return { error: err.message };
  }
}
