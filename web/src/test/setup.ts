import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Sections load lazily; under a busy machine their first import can exceed the 1 s default.
// Only the wait grows: every query still asserts the same element.
configure({ asyncUtilTimeout: 3000 });

// jsdom does not implement the native dialog lifecycle used by the browser.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
