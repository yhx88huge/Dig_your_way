import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 60000,
  expect: { timeout: 8000 }, reporter: [['list'],['json',{outputFile:'artifacts/browser-results.json'}]],
  use: { baseURL: process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000', channel: 'msedge', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name:'desktop', use:{ ...devices['Desktop Edge'], viewport:{width:1440,height:1000} } },{name:'mobile',use:{...devices['Pixel 7'],defaultBrowserType:'chromium',channel:'msedge'}}],
});
