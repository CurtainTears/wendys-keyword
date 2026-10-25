import http from "node:http";

const req = http.get(
  {
    hostname: "127.0.0.1",
    port: Number(process.env.PORT || 3000),
    path: "/api/health",
    timeout: 5000,
    headers: {
      Host: new URL(process.env.APP_ORIGIN || "http://127.0.0.1:3000").host,
    },
  },
  (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      raw += chunk;
    });
    res.on("end", () => {
      try {
        if (res.statusCode !== 200 || JSON.parse(raw).ok !== true)
          process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
  },
);
req.on("timeout", () => req.destroy(new Error("Health check timed out")));
req.on("error", () => {
  process.exitCode = 1;
});
