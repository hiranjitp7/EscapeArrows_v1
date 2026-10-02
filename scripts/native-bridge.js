import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import {
	AdMob, AdmobConsentStatus, AdmobConsentDebugGeography, BannerAdPosition, BannerAdSize, BannerAdPluginEvents,
	InterstitialAdPluginEvents, RewardAdPluginEvents,
} from '@capacitor-community/admob';
import { NativePurchases, PURCHASE_TYPE } from '@capgo/native-purchases';
import adConfig from './ad-config.json';
import { createAdManager } from './ad-manager.js';

const runtimeAdConfig={...adConfig,isDebugBuild:window.EscapeArrowsBuild?.isDebugBuild?.()===true};
const ads=createAdManager({Capacitor,AdMob,AdmobConsentStatus,AdmobConsentDebugGeography,BannerAdPosition,BannerAdSize,
	BannerAdPluginEvents,InterstitialAdPluginEvents,RewardAdPluginEvents,NativePurchases,PURCHASE_TYPE},runtimeAdConfig);
window.ArrowNative = { Capacitor, Haptics, ImpactStyle, Preferences, AdMob, NativePurchases, PURCHASE_TYPE, adConfig:runtimeAdConfig, ads };
