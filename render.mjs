import { pdfToPng } from 'pdf-to-png-converter';
const pages = await pdfToPng('./recon-out/doc-243834192.pdf', { outputFolder: './recon-out', viewportScale: 1.0 });
console.log('rendered:', pages.map(p => `${p.name} ${p.width}x${p.height}`).join(', '));
