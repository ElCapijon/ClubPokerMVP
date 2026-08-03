import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Mobile-specific overrides (media queries + --card-* sizes) must load
// AFTER index.css so they win the cascade.
import './mobile-overrides.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
