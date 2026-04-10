import fs from "node:fs/promises";

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  homepage: string | null;
}

const packageJsonUrl = new URL("../package.json", import.meta.url);

export async function loadPackageInfo(): Promise<PackageInfo> {
  const raw = await fs.readFile(packageJsonUrl, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  return {
    name: typeof parsed.name === "string" ? parsed.name : "kavi",
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    description: typeof parsed.description === "string" ? parsed.description : "",
    homepage: typeof parsed.homepage === "string" ? parsed.homepage : null
  };
}
