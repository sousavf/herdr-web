function isSynchronizedOutputMode(params) {
  return Array.isArray(params) && params.length === 1 && params[0] === 2026;
}

export function registerSynchronizedOutputWorkaround(terminal) {
  const enable = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    isSynchronizedOutputMode,
  );
  const disable = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "l" },
    isSynchronizedOutputMode,
  );
  return [enable, disable];
}
