// Deployment configuration — loaded before the app (plain script, sets a global).
window.GENOME_CONFIG = {
  // Endpoint base for the AI protein-role summaries (the ℹ panel).
  //   • Local dev with server.py running ........ 'api'   (relative — works out of the box)
  //   • Static hosting, no backend (GitHub Pages)  null    (feature shows a "needs a server" note)
  //   • Static hosting + a serverless function ... 'https://your-function.example.com/api'
  // The genome viewer + AlphaFold protein structure work regardless of this setting;
  // only the Claude-generated text summaries need a server (to hold the API key).
  summaryApi: 'api',
};
