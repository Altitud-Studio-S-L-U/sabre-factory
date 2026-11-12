import { test, expect } from '@playwright/test';

test('signed-out text retains contrast on both login panels', async ({ page }) => {
  await page.route('**/api/v1/panel/session', (route) =>
    route.fulfill({ status: 401, json: { detail: 'Unauthorized' } }),
  );
  await page.goto('/runs');
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  const measurements = await page.locator('[data-contrast]').evaluateAll((elements) => {
    const probe = document.createElement('canvas').getContext('2d')!;
    const srgb = (color: string) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (color: string) => {
      const rgb = srgb(color)
        .map(Number)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return elements.map((element) => {
      let surface: Element | null = element;
      while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)')
        surface = surface.parentElement;
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(surface!).backgroundColor);
      return {
        text: element.textContent,
        ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      };
    });
  });
  for (const item of measurements) expect(item.ratio, item.text ?? '').toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: `../work/login-contrast-${test.info().project.name}.png`, fullPage: true });
});
