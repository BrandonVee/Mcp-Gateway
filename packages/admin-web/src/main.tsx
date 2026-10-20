import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'antd/dist/reset.css';
import { App } from '@/web/App';
import '@/web/styles.css';
import '@/web/styles/tech-theme.css';
import '@/web/styles/light-theme.css';
import '@/web/styles/typography.css';
import '@/web/components/form-modal.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
