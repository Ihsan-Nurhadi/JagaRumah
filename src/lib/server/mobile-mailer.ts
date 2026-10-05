import net from "node:net";
import tls from "node:tls";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} belum diisi`);
  return value;
}

function smtpCommand(socket: net.Socket | tls.TLSSocket, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/^\d{3} /.test(text)) {
        socket.off("data", onData);
        resolve(text);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`${command}\r\n`);
  });
}

export async function sendPasswordResetEmail(input: { to: string; name: string; code: string }): Promise<void> {
  const host = required("MAILTRAP_SMTP_HOST");
  const port = Number(process.env.MAILTRAP_SMTP_PORT ?? "2525");
  const username = required("MAILTRAP_SMTP_USERNAME");
  const password = required("MAILTRAP_SMTP_PASSWORD");
  const from = required("MAILTRAP_FROM_EMAIL");
  const fromName = process.env.MAILTRAP_FROM_NAME?.trim() || "Nayaka";
  let socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    if (port === 465) {
      const secure = tls.connect({ host, port, rejectUnauthorized: true });
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    } else {
      const plain = net.connect({ host, port });
      plain.once("connect", () => resolve(plain));
      plain.once("error", reject);
    }
  });
  try {
    await smtpCommand(socket, "EHLO nayaka");
    if (port !== 465) {
      await smtpCommand(socket, "STARTTLS");
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket, host, rejectUnauthorized: true }, () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      socket = secure;
      await smtpCommand(socket, "EHLO nayaka");
    }
    await smtpCommand(socket, "AUTH LOGIN");
    await smtpCommand(socket, Buffer.from(username).toString("base64"));
    await smtpCommand(socket, Buffer.from(password).toString("base64"));
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${input.to}>`);
    const body = [
      `From: ${fromName} <${from}>`, `To: ${input.to}`, "Subject: Kode reset password Nayaka", "Content-Type: text/plain; charset=utf-8", "", `Halo ${input.name},`, "", `Kode reset password: ${input.code}`, "Kode berlaku 15 menit.", "Jika bukan Anda, abaikan email ini.", "",
    ].join("\r\n");
    await smtpCommand(socket, `DATA`);
    await smtpCommand(socket, `${body}\r\n.`);
    await smtpCommand(socket, "QUIT");
  } finally { socket.destroy(); }
}
