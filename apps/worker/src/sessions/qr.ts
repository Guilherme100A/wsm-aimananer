// Renderiza o QR do WhatsApp como data URL (image/png) para a API/dashboard (AC-T05-02).
import QRCode from 'qrcode'

export function toQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 })
}
