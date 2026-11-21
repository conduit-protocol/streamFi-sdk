import { test, expect } from '@playwright/test';

test.describe('SDK browser compatibility', () => {
  test('loads and passes all tests in Chromium', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.summary', { timeout: 60000 });
    const summary = await page.textContent('.summary');
    expect(summary).toContain('ALL');
  });

  test('loads and passes all tests in Firefox', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.summary', { timeout: 60000 });
    const summary = await page.textContent('.summary');
    expect(summary).toContain('ALL');
  });

  test('loads and passes all tests in WebKit', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.summary', { timeout: 60000 });
    const summary = await page.textContent('.summary');
    expect(summary).toContain('ALL');
  });
});
