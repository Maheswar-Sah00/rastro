import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './console/styles/console.css';
import ConsoleApp from './console/ConsoleApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConsoleApp />
  </StrictMode>,
);
