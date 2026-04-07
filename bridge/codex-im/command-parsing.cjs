function extractBindPath(text) {
  return stripTrailingCommandDecorations(extractCommandArgument(text, '/codex bind '));
}

function extractSwitchThreadId(text) {
  const argument = stripTrailingCommandDecorations(extractCommandArgument(text, '/codex switch '));
  return argument.split(/\s+/)[0] || '';
}

function extractCommandArgument(text, prefix) {
  const trimmed = normalizeCommandText(text);
  const normalizedPrefix = String(prefix || '').toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return '';
}

function normalizeCommandText(text) {
  const trimmed = String(text || '').trim();
  const codexIndex = trimmed.toLowerCase().indexOf('/codex');
  const commandSlice = codexIndex >= 0 ? trimmed.slice(codexIndex).trim() : trimmed;
  return stripCommandDecorations(commandSlice);
}

function stripTrailingCommandDecorations(value) {
  return stripCommandDecorations(value);
}

function stripCommandDecorations(value) {
  let normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(/(?:^|\s)@\S+/gu, ' ').trim();
  normalized = normalized.replace(/<at\b[^>]*>.*?<\/at>/giu, ' ').trim();

  const suffixMarkers = [' ['];
  for (const marker of suffixMarkers) {
    const index = normalized.indexOf(marker);
    if (index > 0) {
      normalized = normalized.slice(0, index).trim();
    }
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

module.exports = {
  extractBindPath,
  extractSwitchThreadId,
  normalizeCommandText,
};
