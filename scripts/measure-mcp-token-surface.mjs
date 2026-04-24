import { getCapabilityCatalog } from "../src/mcp/capabilityCatalog.js";
import { getCodeModeTools } from "../src/mcp/codeMode.js";
import { getTools } from "../src/mcp/tools.js";

function measure(label, value) {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  return {
    label,
    count: Array.isArray(value) ? value.length : undefined,
    bytes,
    estimatedTokens: Math.ceil(bytes / 4)
  };
}

const measurements = [
  measure("default_native_tools", getTools({ includeOutputSchema: false })),
  measure("default_native_tools_with_output_schema", getTools({ includeOutputSchema: true })),
  measure("all_native_tools_with_output_schema", getTools({ includeHidden: true, includeOutputSchema: true })),
  measure("codemode_tools", getCodeModeTools()),
  measure("capability_catalog", getCapabilityCatalog())
];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  measurements
}, null, 2));
