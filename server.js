// Keep the original `node server.js` entry point.
import('./server/app.mjs').then(({ start }) => start()).catch(error => {
  console.error('启动失败：', error.message);
  process.exitCode = 1;
});
