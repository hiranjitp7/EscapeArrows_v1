export function createAdManager({
  Capacitor,
  AdMob,
  AdmobConsentStatus,
  AdmobConsentDebugGeography,
  BannerAdSize,
  BannerAdPosition,
  BannerAdPluginEvents,
  InterstitialAdPluginEvents,
  RewardAdPluginEvents,
  NativePurchases,
  PURCHASE_TYPE,
}, config) {
  const storageKey='escapeArrows.adManager';
  const readState=()=>{
    try{
      const state=JSON.parse(localStorage.getItem(storageKey)||'{}');
      return {
        clearedLevels:Array.isArray(state.clearedLevels)?state.clearedLevels.map(String):[],
        lastInterstitialAt:Number(state.lastInterstitialAt)||0,
        lastRewardedAt:Number(state.lastRewardedAt)||0,
        removeAds:state.removeAds===true,
      };
    }catch{return {clearedLevels:[],lastInterstitialAt:0,lastRewardedAt:0,removeAds:false};}
  };
  const state=readState(),listeners=new Set(),bannerHeightListeners=new Set();
  let initialized=false,initializing=null,rewardedReady=false,interstitialReady=false;
  let rewardedLoading=null,interstitialLoading=null,removeAdsPrice='',bannerHeight=config.reservedBannerHeight;
  let consentRequested=false,privacyOptionsAvailable=false;
  const isNative=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android';
  const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{}};
  const notify=()=>listeners.forEach(listener=>listener(getStatus()));
  const setBannerHeight=height=>{
    bannerHeight=Math.max(0,Math.ceil(Number(height)||0));
    bannerHeightListeners.forEach(listener=>listener(bannerHeight));
  };
  const getStatus=()=>({
    isNative:isNative(),initialized,consentAllowed:initialized,
    rewardedReady,interstitialReady,removeAds:state.removeAds,
    removeAdsPrice,bannerHeight,privacyOptionsAvailable,
  });
  const subscribe=listener=>{listeners.add(listener);listener(getStatus());return()=>listeners.delete(listener);};
  const onBannerHeightChange=listener=>{bannerHeightListeners.add(listener);listener(bannerHeight);return()=>bannerHeightListeners.delete(listener);};
  const prepareRewarded=()=>{
    if(!config.androidRewardedId||!initialized||!isNative()||rewardedReady||rewardedLoading)return rewardedLoading;
    rewardedLoading=AdMob.prepareRewardVideoAd({adId:config.androidRewardedId,isTesting:config.testAds})
      .then(()=>{rewardedReady=true;notify();return true;})
      .catch(()=>{rewardedReady=false;notify();setTimeout(()=>void prepareRewarded(),30000);return false;})
      .finally(()=>{rewardedLoading=null;});
    return rewardedLoading;
  };
  const prepareInterstitial=()=>{
    if(!config.androidInterstitialId||!initialized||!isNative()||state.removeAds||interstitialReady||interstitialLoading)return interstitialLoading;
    interstitialLoading=AdMob.prepareInterstitial({adId:config.androidInterstitialId,isTesting:config.testAds})
      .then(()=>{interstitialReady=true;notify();return true;})
      .catch(()=>{interstitialReady=false;notify();setTimeout(()=>void prepareInterstitial(),30000);return false;})
      .finally(()=>{interstitialLoading=null;});
    return interstitialLoading;
  };
  const refreshRemoveAds=async()=>{
    if(!isNative())return state.removeAds;
    try{
      const {purchases}=await NativePurchases.getPurchases({productType:PURCHASE_TYPE.INAPP});
      state.removeAds=(purchases||[]).some(purchase=>purchase.productIdentifier===config.removeAdsProductId&&
        (purchase.purchaseState===undefined||purchase.purchaseState==='1'||purchase.purchaseState==='PURCHASED'));
      save();notify();
    }catch{}
    return state.removeAds;
  };
  const loadRemoveAdsProduct=async()=>{
    if(!isNative())return '';
    try{
      const {isBillingSupported}=await NativePurchases.isBillingSupported();
      if(!isBillingSupported)return '';
      const {product}=await NativePurchases.getProduct({productIdentifier:config.removeAdsProductId,productType:PURCHASE_TYPE.INAPP});
      removeAdsPrice=product?.priceString||'';notify();
    }catch{removeAdsPrice='';notify();}
    return removeAdsPrice;
  };
  const removeBanner=async()=>{
    if(!isNative())return;
    try{await AdMob.removeBanner();}catch{}
    setBannerHeight(0);
  };
  const showBanner=async()=>{
    if(!initialized||!isNative()||state.removeAds)return false;
    try{
      await AdMob.showBanner({adId:config.androidBannerId,adSize:BannerAdSize.ADAPTIVE_BANNER,
        position:BannerAdPosition.BOTTOM_CENTER,margin:0,isTesting:config.testAds});
      return true;
    }catch{setTimeout(()=>void showBanner(),30000);return false;}
  };
  const initialize=()=>{
    if(initialized)return Promise.resolve(true);
    if(initializing)return initializing;
    if(!isNative())return Promise.resolve(false);
    initializing=(async()=>{
      try{
        const consentDebug=config.UMP_DEBUG_ENABLED===true&&config.isDebugBuild===true?{
          debugGeography:AdmobConsentDebugGeography.EEA,
          testDeviceIdentifiers:[config.UMP_TEST_DEVICE_ID],
        }:undefined;
        if(consentDebug)await AdMob.resetConsentInfo();
        let consent=await AdMob.requestConsentInfo(consentDebug);
        consentRequested=true;
        if(consent.isConsentFormAvailable&&consent.status===AdmobConsentStatus.REQUIRED)
          consent=await AdMob.showConsentForm();
        privacyOptionsAvailable=consent.privacyOptionsRequirementStatus==='REQUIRED';
        if(!consent.canRequestAds){await refreshRemoveAds();void loadRemoveAdsProduct();return false;}
        await AdMob.initialize();
        initialized=true;
        await Promise.all([
          AdMob.addListener(BannerAdPluginEvents.SizeChanged,info=>setBannerHeight(info.height)),
          AdMob.addListener(BannerAdPluginEvents.FailedToLoad,()=>{setBannerHeight(0);setTimeout(()=>void showBanner(),30000);}),
          AdMob.addListener(RewardAdPluginEvents.Loaded,()=>{rewardedReady=true;notify();}),
          AdMob.addListener(RewardAdPluginEvents.FailedToLoad,()=>{rewardedReady=false;notify();}),
          AdMob.addListener(RewardAdPluginEvents.Showed,()=>{state.lastRewardedAt=Date.now();save();}),
          AdMob.addListener(RewardAdPluginEvents.Dismissed,()=>{rewardedReady=false;notify();void prepareRewarded();}),
          AdMob.addListener(RewardAdPluginEvents.FailedToShow,()=>{rewardedReady=false;notify();void prepareRewarded();}),
          AdMob.addListener(InterstitialAdPluginEvents.Loaded,()=>{interstitialReady=true;notify();}),
          AdMob.addListener(InterstitialAdPluginEvents.FailedToLoad,()=>{interstitialReady=false;notify();}),
          AdMob.addListener(InterstitialAdPluginEvents.Showed,()=>{state.lastInterstitialAt=Date.now();save();}),
          AdMob.addListener(InterstitialAdPluginEvents.Dismissed,()=>{interstitialReady=false;notify();void prepareInterstitial();}),
          AdMob.addListener(InterstitialAdPluginEvents.FailedToShow,()=>{interstitialReady=false;notify();void prepareInterstitial();}),
        ]);
        await refreshRemoveAds();
        if(!state.removeAds)void showBanner();
        void loadRemoveAdsProduct();
        void prepareRewarded();
        void prepareInterstitial();
        return true;
      }catch{setTimeout(()=>void initialize(),30000);return false;}
      finally{initializing=null;}
    })();
    return initializing;
  };
  const showRewarded=async()=>{
    if(!initialized||!isNative()||!rewardedReady)return false;
    rewardedReady=false;notify();
    let earned=false;
    try{
      const reward=await AdMob.showRewardVideoAd();
      earned=!!reward;
      if(earned){state.lastRewardedAt=Date.now();save();}
    }catch{}
    finally{void prepareRewarded();}
    return earned;
  };
  const recordLevelClear=(level,alreadyCleared=false)=>{
    const key=String(level),known=state.clearedLevels.includes(key);
    if(!known){state.clearedLevels.push(key);save();}
    return !alreadyCleared&&!known;
  };
  const showInterstitialAfterClear=async(level,isFirstClear)=>{
    const eligible=isFirstClear&&level>=8&&(level-8)%4===0&&!state.removeAds&&
      Date.now()-state.lastRewardedAt>=120000&&interstitialReady;
    if(!eligible)return false;
    interstitialReady=false;notify();
    try{
      await AdMob.showInterstitial();
      state.lastInterstitialAt=Date.now();save();
      return true;
    }catch{return false;}
    finally{void prepareInterstitial();}
  };
  const purchaseRemoveAds=async()=>{
    if(!isNative()||!removeAdsPrice)return false;
    try{
      const transaction=await NativePurchases.purchaseProduct({productIdentifier:config.removeAdsProductId,productType:PURCHASE_TYPE.INAPP,quantity:1});
      const purchased=transaction.productIdentifier===config.removeAdsProductId&&
        (transaction.purchaseState===undefined||transaction.purchaseState==='1'||transaction.purchaseState==='PURCHASED')&&
        transaction.isAcknowledged!==false;
      if(!purchased)return false;
      state.removeAds=true;save();notify();await removeBanner();return true;
    }catch{return false;}
  };
  const restorePurchases=async()=>{
    if(!isNative())return false;
    try{
      await NativePurchases.restorePurchases();
      const owned=await refreshRemoveAds();
      if(owned)await removeBanner();
      return owned;
    }catch{return false;}
  };
  const showPrivacyOptions=async()=>{
    if(!isNative()||!consentRequested||!privacyOptionsAvailable)return false;
    try{await AdMob.showPrivacyOptionsForm();return true;}catch{return false;}
  };
  const canShowInterstitial=()=>initialized&&isNative()&&!state.removeAds&&interstitialReady&&Date.now()-state.lastRewardedAt>=120000;
  return {initialize,subscribe,onBannerHeightChange,getStatus,prepareRewarded,showRewarded,
    recordLevelClear,showInterstitialAfterClear,canShowInterstitial,loadRemoveAdsProduct,
    purchaseRemoveAds,restorePurchases,showPrivacyOptions,showBanner,removeBanner};
}
