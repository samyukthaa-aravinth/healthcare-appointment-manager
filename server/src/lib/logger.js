const stamp = () => new Date().toISOString();
const write = (level, msg, meta) => {
  const line = `${stamp()} ${level.padEnd(5)} ${msg}`;
  if (meta !== undefined) console.log(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
  else console.log(line);
};

export const logger = {
  info: (m, meta) => write('INFO', m, meta),
  warn: (m, meta) => write('WARN', m, meta),
  error: (m, meta) =>
    write('ERROR', m, meta instanceof Error ? { message: meta.message, stack: meta.stack } : meta)
};
