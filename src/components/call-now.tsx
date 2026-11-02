"use client";
// "Call now": opens the RingCentral app with the driver's number already typed in
// (the desktop app on a computer, the mobile app on a phone).
import { useEffect, useState } from "react";
import { Icon } from "./icons";

export function ringCentralHref(phoneE164: string, mobile: boolean) {
  const n = phoneE164.replace(/\D/g, "");
  return mobile ? `rcmobile://call?number=${n}` : `rcapp://r/call?number=${n}`;
}

export function CallNow({ phone, label = "Call now", className = "btn" }: { phone: string; label?: string; className?: string }) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => { setMobile(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)); }, []);
  return (
    <a className={`${className} call-now`} href={ringCentralHref(phone, mobile)} title={`Call ${phone} in RingCentral`}>
      <Icon name="phone" size={15} />{label}
    </a>
  );
}
