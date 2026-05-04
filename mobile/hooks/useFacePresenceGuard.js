import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

const DEFAULT_NO_FACE_TIMEOUT_MS = 2000;
const DEFAULT_DETECTION_FPS = 3;
const isWeb = Platform.OS === 'web';

let Camera = null;
let runAsync = null;
let runAtTargetFps = null;
let useCameraDevice = null;
let useCameraPermission = null;
let useFrameProcessor = null;
let useFaceDetector = null;
let useRunOnJS = null;

if (!isWeb) {
  try {
    const visionCamera = require('react-native-vision-camera');
    const faceDetector = require('react-native-vision-camera-face-detector');
    const worklets = require('react-native-worklets-core');

    Camera = visionCamera.Camera;
    runAsync = visionCamera.runAsync;
    runAtTargetFps = visionCamera.runAtTargetFps;
    useCameraDevice = visionCamera.useCameraDevice;
    useCameraPermission = visionCamera.useCameraPermission;
    useFrameProcessor = visionCamera.useFrameProcessor;
    useFaceDetector = faceDetector.useFaceDetector;
    useRunOnJS = worklets.useRunOnJS;
  } catch (error) {
    // Native kamera modulu yoksa web/demo akisi kamera guard'i olmadan devam eder.
  }
}

const hasNativeFaceCamera =
  !isWeb &&
  Camera &&
  runAsync &&
  runAtTargetFps &&
  useCameraDevice &&
  useCameraPermission &&
  useFrameProcessor &&
  useFaceDetector &&
  useRunOnJS;

export function useFacePresenceGuard({
  detectionFps = DEFAULT_DETECTION_FPS,
  enabled = true,
  fallbackRouteName = 'Home',
  navigation,
  noFaceTimeoutMs = DEFAULT_NO_FACE_TIMEOUT_MS,
  onExit,
} = {}) {
  if (!hasNativeFaceCamera) {
    return {
      canEnterChat: true,
      device: null,
      frameProcessor: null,
      guardMessage: 'Kamera guard web demosunda devre disi.',
      hasPermission: true,
      isCameraActive: false,
      isExiting: false,
      isFacePresent: null,
      permissionRequested: true,
      requestPermission: async () => true,
      shouldRenderCamera: false,
    };
  }

  const device = useCameraDevice('front');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isFacePresent, setIsFacePresent] = useState(null);
  const lastFaceSeenAtRef = useRef(Date.now());
  const noFaceTimerRef = useRef(null);
  const exitedRef = useRef(false);

  const faceDetectionOptions = useMemo(
    () => ({
      cameraFacing: 'front',
      classificationMode: 'none',
      contourMode: 'none',
      landmarkMode: 'none',
      minFaceSize: 0.15,
      performanceMode: 'fast',
      trackingEnabled: false,
    }),
    [],
  );
  const { detectFaces, stopListeners } = useFaceDetector(faceDetectionOptions);

  const clearNoFaceTimer = useCallback(() => {
    if (noFaceTimerRef.current) {
      clearTimeout(noFaceTimerRef.current);
      noFaceTimerRef.current = null;
    }
  }, []);

  const exitChat = useCallback((reason = 'face') => {
    if (exitedRef.current) {
      return;
    }

    exitedRef.current = true;
    setIsExiting(true);
    clearNoFaceTimer();
    onExit?.(reason);

    if (
      typeof navigation?.canGoBack === 'function' &&
      navigation.canGoBack() &&
      typeof navigation?.goBack === 'function'
    ) {
      navigation.goBack();
      return;
    }

    if (typeof navigation?.goBack === 'function' && typeof navigation?.canGoBack !== 'function') {
      navigation.goBack();
      return;
    }

    if (typeof navigation?.replace === 'function') {
      navigation.replace(fallbackRouteName);
    }
  }, [clearNoFaceTimer, fallbackRouteName, navigation, onExit]);

  const scheduleNoFaceExit = useCallback(() => {
    if (noFaceTimerRef.current || exitedRef.current) {
      return;
    }

    const elapsed = Date.now() - lastFaceSeenAtRef.current;
    const remaining = Math.max(0, noFaceTimeoutMs - elapsed);
    noFaceTimerRef.current = setTimeout(() => exitChat('face'), remaining);
  }, [exitChat, noFaceTimeoutMs]);

  const handleFaceCount = useRunOnJS((faceCount) => {
    if (exitedRef.current) {
      return;
    }

    const hasFace = faceCount > 0;
    setIsFacePresent((current) => (current === hasFace ? current : hasFace));

    if (hasFace) {
      lastFaceSeenAtRef.current = Date.now();
      clearNoFaceTimer();
      return;
    }

    scheduleNoFaceExit();
  }, [clearNoFaceTimer, scheduleNoFaceExit]);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';

      if (!enabled) {
        return;
      }

      runAtTargetFps(detectionFps, () => {
        'worklet';
        runAsync(frame, () => {
          'worklet';
          const faces = detectFaces(frame);
          handleFaceCount(faces.length);
        });
      });
    },
    [detectFaces, detectionFps, enabled, handleFaceCount],
  );

  useEffect(() => {
    if (!enabled || hasPermission) {
      setPermissionRequested(true);
      return undefined;
    }

    let active = true;
    requestPermission()
      .catch(() => false)
      .finally(() => {
        if (active) {
          setPermissionRequested(true);
        }
      });

    return () => {
      active = false;
    };
  }, [enabled, hasPermission, requestPermission]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        exitChat('background');
      }
    });

    return () => subscription.remove();
  }, [enabled, exitChat]);

  useEffect(() => {
    return () => {
      clearNoFaceTimer();
      stopListeners();
    };
  }, [clearNoFaceTimer, stopListeners]);

  const canEnterChat = !enabled || (hasPermission && !!device && !isExiting);
  const shouldRenderCamera = enabled && hasPermission && !!device && !isExiting;
  const guardMessage = !hasPermission
    ? 'Chat icin on kamera izni gerekiyor.'
    : 'On kamera bulunamadi.';

  return {
    canEnterChat,
    device,
    frameProcessor,
    guardMessage,
    hasPermission,
    isCameraActive: shouldRenderCamera,
    isExiting,
    isFacePresent,
    permissionRequested,
    requestPermission,
    shouldRenderCamera,
  };
}

export function FacePresenceCamera({ guard, style }) {
  if (!guard.shouldRenderCamera) {
    return null;
  }

  return (
    <Camera
      device={guard.device}
      frameProcessor={guard.frameProcessor}
      isActive={guard.isCameraActive}
      pixelFormat="yuv"
      style={style}
    />
  );
}
