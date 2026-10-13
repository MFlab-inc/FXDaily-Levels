"use strict";
// 試験用: --require で読み込み、子プロセスの『現在時刻』を環境変数 FAKE_NOW_MS から進める（実時間と同じ速さで進む）。
// 実時刻に依存しないので、JST の 0 時をまたぐ時間帯に CI が走っても試験が揺れない
const RealDate = Date;
const base = Number(process.env.FAKE_NOW_MS);
const t0 = RealDate.now();
const nowMs = () => base + (RealDate.now() - t0);
if (Number.isFinite(base)) {
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(nowMs()); else super(...a); }
    static now() { return nowMs(); }
  }
  globalThis.Date = FakeDate;
}
