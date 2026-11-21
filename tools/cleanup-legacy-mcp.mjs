import {
  removeLegacyMcpFromCodexPlusSettings,
  removeLegacyMcpRegistration,
} from "../backend/legacy-mcp.mjs";

const config = removeLegacyMcpRegistration();
const settings = removeLegacyMcpFromCodexPlusSettings();
const result = {
  changed: config.changed || settings.changed,
  config,
  settings,
};
console.log(JSON.stringify(result, null, 2));
