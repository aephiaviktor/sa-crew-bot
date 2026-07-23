const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function atomicWriteFile(targetPath, data, encoding = 'utf8', fsImpl = fs) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );

  await fsImpl.mkdir(directory, { recursive: true });
  try {
    await fsImpl.writeFile(temporaryPath, data, encoding);
    await fsImpl.rename(temporaryPath, targetPath);
  } catch (error) {
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = { atomicWriteFile };
