const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`${command} failed with exit code ${result.status}${details ? `\n${details}` : ""}`)
  }
  return result.stdout.trim()
}

module.exports = async context => {
  if (context.electronPlatformName !== "darwin") {
    return
  }

  const apiKey = process.env.APPLE_API_KEY
  const apiKeyId = process.env.APPLE_API_KEY_ID
  const apiIssuer = process.env.APPLE_API_ISSUER
  if (!apiKey || !apiKeyId || !apiIssuer) {
    if (isCI) {
      throw new Error("APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER are required for macOS notarization")
    }
    console.warn("Skipping macOS notarization because personal App Store Connect API key credentials are not configured")
    return
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "livehub-notary-"))
  const keyPath = path.join(tempDir, "AuthKey.p8")
  const appEntry = fs.readdirSync(context.appOutDir, { withFileTypes: true }).find(
    entry => entry.isDirectory() && entry.name.endsWith(".app"),
  )
  if (!appEntry) {
    throw new Error(`Could not find a macOS app bundle in ${context.appOutDir}`)
  }
  const appName = appEntry.name
  const appPath = path.join(context.appOutDir, appName)
  const uploadPath = path.join(tempDir, `${path.parse(appName).name}.zip`)
  fs.writeFileSync(keyPath, apiKey, { encoding: "utf8", mode: 0o600 })

  try {
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appName, uploadPath], {
      cwd: path.dirname(context.appOutDir),
    })

    const rawResult = run("xcrun", [
      "notarytool",
      "submit",
      uploadPath,
      "--key",
      keyPath,
      "--key-id",
      apiKeyId,
      "--issuer",
      apiIssuer,
      "--wait",
      "--output-format",
      "json",
    ])

    let result
    try {
      result = JSON.parse(rawResult)
    } catch {
      throw new Error("xcrun notarytool returned invalid JSON")
    }
    if (result.status !== "Accepted") {
      throw new Error(`Apple notarization was not accepted: ${result.status || "unknown status"}`)
    }

    execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" })
    console.log(`Apple notarization accepted for ${appName}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
