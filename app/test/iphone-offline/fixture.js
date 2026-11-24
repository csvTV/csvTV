import { prepareSample } from './sample-record.js';

const button = document.querySelector('#prepare');
const status = document.querySelector('#result');

button.onclick = async () => {
  button.disabled = true;
  status.textContent = 'Preparing the fictional record…';
  try {
    const { openDeviceStore } = await import('./tracker/storage.js');
    await prepareSample(openDeviceStore, message => { status.textContent = message; });
    location.assign('./tracker/#/settings');
  } catch (error) {
    status.textContent = error.message || 'The sample could not be opened.';
    button.disabled = false;
  }
};
