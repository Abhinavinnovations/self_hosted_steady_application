// Lets CI point the APK at your backend without editing app.json:
//   STEADY_API_URL=https://your-service.onrender.com
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    apiUrl: (process.env.STEADY_API_URL || config.extra?.apiUrl || "").replace(/\/$/, ""),
  },
});
