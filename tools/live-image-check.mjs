// Manual live probe: sends a real Accio-shaped image turn through the running relay
// and reports which model answered, how long it took, and the image bytes returned.
const RELAY = process.env.ACCIO_RELAY_URL || "http://127.0.0.1:43100";
const models = (process.argv[2] || "codexplus-image/qwentokenplan/wan2.7-image-pro")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function payload(model) {
  return {
    model,
    modelName: model,
    contents: [{ role: "user", parts: [{ text: "A single red apple on a white table, studio light." }] }],
    generationConfig: { imageConfig: { aspectRatio: "1:1" } },
  };
}

async function run(model) {
  const started = Date.now();
  try {
    const response = await fetch(`${RELAY}/api/adk/llm/generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Accio/0.39.0.0 (Windows 10.0.26300; x64) AccioBridge/0.1.21",
      },
      body: JSON.stringify(payload(model)),
      signal: AbortSignal.timeout(600000),
    });
      const text = await response.text();
    const frames = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const last = frames[frames.length - 1] || {};
    const parts = last?.content?.parts || [];
    const images = parts.filter((part) => part.inlineData?.data);
    const meta = last.customMetadata || {};
    if (last.errorCode) {
      console.log(`${model} -> ERROR ${last.errorCode}: ${last.errorMessage} (${Date.now() - started}ms)`);
      return;
    }
    console.log(
      `${model} -> HTTP ${response.status} images=${images.length}` +
        ` ${images.map((image) => `${image.inlineData.mimeType} ${Math.round(image.inlineData.data.length * 0.75 / 1024)}KB`).join(", ")}` +
        ` route=${meta.route} model=${meta.model} edits=${meta.edits} (${Date.now() - started}ms)`,
    );
  } catch (error) {
    console.log(`${model} -> FETCH FAILED ${error.name} ${error.message} (${Date.now() - started}ms)`);
  }
}

for (const model of models) await run(model);
