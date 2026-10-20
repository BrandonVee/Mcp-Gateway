import { Modal, type ModalProps } from 'antd';

interface FormModalProps extends ModalProps {
  wide?: boolean;
}

export function FormModal({ wide = false, width, className, ...props }: FormModalProps) {
  return (
    <Modal
      {...props}
      width={width ?? (wide ? 960 : 520)}
      className={['form-modal', className].filter(Boolean).join(' ')}
    />
  );
}
