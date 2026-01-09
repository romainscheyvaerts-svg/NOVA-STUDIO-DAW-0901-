
import { DAWState } from '../types';

// This file serves as a source of truth for the 'Download Project' feature.
// Since we are in a browser environment without a bundler file-system access at runtime,
// we manually map the critical source files here.

export const PROJECT_SOURCE: Record<string, string> = {
  'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Nova DAW</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/index.js"></script>
</body>
</html>`,
  
  'README.md': `# Nova DAW Source Code
  
This archive contains the source code for your Nova DAW session.
To run this locally:
1. Install a local server (e.g., \`npm install -g serve\`)
2. Run \`serve .\` in this directory.
`,

  // Placeholder for dynamic injection or manual mapping of other files if needed.
  // In a full build system, this would be auto-generated.
};
