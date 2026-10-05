-- 0012: password reset codes support email OTP lookup and expiry indexing.
CREATE INDEX auth_verification_codes_reset_target_idx
  ON auth_verification_codes (target, created_at DESC)
  WHERE purpose = 'reset_password' AND consumed_at IS NULL;
