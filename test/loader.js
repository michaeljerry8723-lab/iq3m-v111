export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      shortCircuit: true,
      url: new URL("./mock-cf.js", import.meta.url).href,
      format: "module"
    };
  }
  return nextResolve(specifier, context);
}
