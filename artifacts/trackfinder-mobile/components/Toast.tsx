import { COLORS } from '@/constants/colors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

interface ToastMessage {
  id: number;
  text: string;
}

let _toastId = 0;
const _listeners = new Set<(msg: ToastMessage) => void>();

export function showToast(text: string) {
  const msg: ToastMessage = { id: ++_toastId, text };
  _listeners.forEach((fn) => fn(msg));
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMsg = useCallback((msg: ToastMessage) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    timerRef.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
        setMessage(null);
      });
    }, 3000);
  }, [opacity]);

  useEffect(() => {
    _listeners.add(handleMsg);
    return () => { _listeners.delete(handleMsg); };
  }, [handleMsg]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {message && (
        <Animated.View style={[toastStyles.container, { opacity }]} pointerEvents="none">
          <Text style={toastStyles.text}>{message.text}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 120,
    left: 24,
    right: 24,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  text: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: COLORS.text,
    textAlign: 'center',
  },
});
