import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";
import { config } from "@/lib/config";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(new URL("/login", config.appUrl), 303);
}
