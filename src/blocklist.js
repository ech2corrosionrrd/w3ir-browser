'use strict';
// Базовий список рекламних та трекінгових доменів (блокуються разом із субдоменами).
const DOMAINS = `
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com adservice.google.com
pagead2.googlesyndication.com adnxs.com adsrvr.org taboola.com outbrain.com criteo.com criteo.net
rubiconproject.com pubmatic.com openx.net casalemedia.com advertising.com scorecardresearch.com
quantserve.com quantcount.com moatads.com amazon-adsystem.com ads.yahoo.com analytics.yahoo.com
adform.net smartadserver.com yieldmo.com 33across.com sharethrough.com indexww.com bidswitch.net
contextweb.com lijit.com sovrn.com media.net revcontent.com mgid.com zedo.com adcolony.com
applovin.com unityads.unity3d.com mopub.com inmobi.com chartboost.com vungle.com tapad.com
bluekai.com demdex.net krxd.net exelator.com rlcdn.com everesttech.net serving-sys.com teads.tv
adition.com richaudience.com smaato.net hotjar.com mouseflow.com crazyegg.com fullstory.com
luckyorange.com adroll.com perfectaudience.com rtbhouse.com yandexadexchange.net an.yandex.ru
mc.yandex.ru adriver.ru begun.ru ad.mail.ru top-fwz1.mail.ru counter.yadro.ru
popads.net popcash.net propellerads.com exoclick.com juicyads.com trafficjunky.net trafficfactory.biz
adsterra.com hilltopads.net clickadu.com onclickads.net adcash.com bidvertiser.com infolinks.com
undertone.com conversantmedia.com adsymptotic.com bing.com/aclick
2mdn.net adsafeprotected.com doubleverify.com iasds01.com fwmrm.com innovid.com spotxchange.com
spotx.tv springserve.com stickyadstv.com tremorhub.com imasdk.googleapis.com

an.facebook.com ads-twitter.com ads.linkedin.com ads.pinterest.com ads.tiktok.com
analytics.tiktok.com business-api.tiktok.com sc-static.net tr.snapchat.com
cdn.mxpnl.com api.mixpanel.com stats.g.doubleclick.net track.adform.net id5-sync.com
liveintent.com liadm.com permutive.com permutive.app lotame.com crwdcntrl.net eyeota.net
omtrdc.net 2o7.net sitestat.com chartbeat.com chartbeat.net parsely.com
yieldlab.net yieldlab.de improvedigital.com
gumgum.com triplelift.com adblade.com content.ad zergnet.com
`.split(/\s+/).filter(d => d && !d.includes('/') && d.includes('.'));

const set = new Set(DOMAINS);

function isBlockedHost(host) {
  const parts = host.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function isBlockedUrl(url) {
  if (!/^https?:/i.test(url)) return false;
  try { return isBlockedHost(new URL(url).hostname); } catch { return false; }
}

module.exports = { isBlockedUrl, count: set.size };
