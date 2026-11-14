import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { DataProvider, LiveProvider, ToastProvider } from './context';
import './styles.css';
import './app.css';
import './styles/chart.css';
import './mobile.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <LiveProvider>
          <DataProvider>
            <App />
          </DataProvider>
        </LiveProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
