import { MaterialIcons, MaterialIconName } from '@/components/MaterialIcons';
import { COLORS } from '@/constants/colors';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ActionItem {
  label: string;
  icon: MaterialIconName;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  actions: ActionItem[];
}

export function TrackActionSheet({ visible, onClose, title, subtitle, actions }: Props) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(300)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: 300,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const handleAction = (action: ActionItem) => {
    if (action.disabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    setTimeout(() => action.onPress(), 100);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose} accessible={false}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, 16) + 8 },
          { transform: [{ translateY: slideAnim }] },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.handle} />

        <View style={styles.trackInfo}>
          <Text style={styles.trackTitle} numberOfLines={1}>{title}</Text>
          {subtitle ? (
            <Text style={styles.trackArtist} numberOfLines={1}>{subtitle}</Text>
          ) : null}
        </View>

        <View style={styles.divider} />

        {actions.map((action, i) => (
          <Pressable
            key={i}
            style={({ pressed }) => [
              styles.actionRow,
              pressed && !action.disabled && styles.actionRowPressed,
              action.disabled && styles.actionRowDisabled,
            ]}
            onPress={() => handleAction(action)}
            disabled={action.disabled}
          >
            <View style={[styles.actionIcon, action.destructive && styles.actionIconDestructive]}>
              <MaterialIcons
                name={action.icon}
                size={20}
                color={action.disabled ? COLORS.textMuted : action.destructive ? COLORS.danger : COLORS.accent}
              />
            </View>
            <Text
              style={[
                styles.actionLabel,
                action.destructive && styles.actionLabelDestructive,
                action.disabled && styles.actionLabelDisabled,
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}

        <Pressable style={styles.cancelBtn} onPress={onClose}>
          <Text style={styles.cancelLabel}>Отмена</Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 8,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderLight,
    alignSelf: 'center',
    marginBottom: 8,
  },
  trackInfo: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 2,
  },
  trackTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  trackArtist: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginBottom: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  actionRowPressed: {
    backgroundColor: COLORS.card,
  },
  actionRowDisabled: {
    opacity: 0.4,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: COLORS.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconDestructive: {
    backgroundColor: COLORS.dangerBg,
  },
  actionLabel: {
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
    color: COLORS.text,
    flex: 1,
  },
  actionLabelDestructive: {
    color: COLORS.danger,
  },
  actionLabelDisabled: {
    color: COLORS.textMuted,
  },
  cancelBtn: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  cancelLabel: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
});
