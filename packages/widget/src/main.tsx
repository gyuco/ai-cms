import { mount } from './element.tsx';

// Entry point of /_cms/widget.js: importing the module is enough to show the widget.
if (document.body) {
  mount();
} else {
  document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
}
