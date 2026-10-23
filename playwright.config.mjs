import {defineConfig} from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// This server is a synthetic test fixture, never the user's DSH GUI.
export default defineConfig({
  testDir:'./test/browser',
  testMatch:'**/*.spec.mjs',
  fullyParallel:false,
  workers:1,
  retries:0,
  timeout:30000,
  expect:{timeout:5000},
  reporter:'list',
  outputDir:process.env.DSH_BROWSER_OUTPUT||path.join(os.tmpdir(),'dsh-code-report-browser-results'),
  use:{
    baseURL:'http://127.0.0.1:4178',
    browserName:'chromium',
    ...(process.env.DSH_BROWSER_CHANNEL?{channel:process.env.DSH_BROWSER_CHANNEL}:{}),
    viewport:{width:1280,height:900},
    acceptDownloads:true,
    trace:'retain-on-failure',
    screenshot:'only-on-failure',
  },
  webServer:{command:'node test/browser/server.mjs',url:'http://127.0.0.1:4178/health',reuseExistingServer:false,timeout:30000,gracefulShutdown:{signal:'SIGTERM',timeout:3000}},
});
